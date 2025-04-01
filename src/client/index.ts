import { RequestDoneData, RequestMetadata } from "../request/types";
import { Authenticator } from "../authenticator";
import processRequests from "./processRequests";
import axios, { AxiosInstance } from "axios";
import handleRequest from "./handleRequest";
import * as ClientTypes from "./types";
import updateRole from "./updateRole";
import { Logger } from "winston";
import IORedis from "ioredis";
import { v4 } from "uuid";

export default class Client {
  public name: string;
  public metadata?: { [key: string]: any };
  public requestOptions: ClientTypes.RequestOptions;
  public rateLimit: ClientTypes.RateLimitData;
  protected authenticator?: Authenticator;
  protected createData: ClientTypes.CreateClientData;
  protected retryOptions: ClientTypes.RetryOptions;
  protected rateLimitChange?: ClientTypes.RateLimitChange;
  protected http: AxiosInstance;
  protected id: string = v4();
  protected role: ClientTypes.ClientRole = "worker";
  protected redis: IORedis;
  protected requestHandlerRedisName: string;
  protected redisName: string;
  protected addTokensInterval?: NodeJS.Timeout;
  protected healthCheckInterval?: NodeJS.Timeout;
  protected hasUnsortedRequests: boolean = false;
  protected requestsInQueue: Map<string, RequestMetadata> = new Map();
  protected requestsInProgress: Map<string, RequestMetadata> = new Map();
  protected httpStatusCodesToMute: number[];
  protected emitter: NodeJS.EventEmitter;
  protected logger: Logger;
  protected tokens: number;
  protected maxTokens: number;
  protected tokensToAdd: number;
  protected freezeTimeout?: NodeJS.Timeout;
  protected thawRequestCount: number = 0;
  protected thawRequestId?: string;
  protected processingId?: string;

  public handleRequest = handleRequest.bind(this);
  public updateRole = updateRole.bind(this);

  constructor(data: ClientTypes.ClientConstructorData) {
    this.emitter = data.emitter;
    this.http = axios.create(data.client.axiosOptions);
    this.logger = data.logger;
    this.redis = data.redis;
    this.name = data.client.name;
    this.createData = data.client;
    this.requestHandlerRedisName = data.requestHandlerRedisName;
    this.redisName = `${data.requestHandlerRedisName}:${(
      data.client.sharedRateLimitClientName || data.client.name
    ).replaceAll(/ /g, "_")}`;
    this.rateLimit = data.client.rateLimit || { type: "noLimit" };
    if (this.rateLimit.type === "noLimit") this.maxTokens = Infinity;
    else this.maxTokens = this.rateLimit.maxTokens;
    if (this.rateLimit.type !== "requestLimit") this.tokensToAdd = 1;
    else this.tokensToAdd = this.rateLimit.tokensToAdd;
    this.tokens = this.maxTokens;
    this.metadata = data.client.metadata;
    this.requestOptions = data.client.requestOptions || {};
    this.rateLimitChange = data.client.rateLimitChange;
    const { retryOptions } = data.client;
    this.httpStatusCodesToMute = data.client.httpStatusCodesToMute || [];
    this.retryOptions = {
      retryBackoffBaseTime: retryOptions?.retryBackoffBaseTime || 1000,
      retryBackoffMethod: retryOptions?.retryBackoffMethod || "exponential",
      retry429s: retryOptions?.retry429s || true,
      retry5xxs: retryOptions?.retry5xxs || true,
      maxRetries: retryOptions?.maxRetries || 3,
      retryStatusCodes: retryOptions?.retryStatusCodes || [],
      thawRequestCount: retryOptions?.thawRequestCount || 3,
    };
    if (!data.client.authentication) return;
    this.authenticator = new Authenticator(
      data.client.authentication,
      this.redis,
      this.redisName,
      data.key
    );
  }

  /**
   * This method initializes the client by updating the rate limit and subscribing to channels in Redis.
   */

  public async init() {
    await this.updateRateLimit(this.rateLimit);
    this.emitter.on(
      `${this.redisName}:processRequests`,
      processRequests.bind(this)
    );
  }

  /**
   * Updates the rate limit data for the client in Redis and publishes the new rate limit data to the requestHandler so that other nodes can update their clients.
   *
   * @param data The new rate limit data
   */

  protected async updateRateLimit(data: ClientTypes.RateLimitData) {
    await this.redis.set(`${this.redisName}:rateLimit`, JSON.stringify(data));
    const updatedData: ClientTypes.RateLimitUpdatedData = {
      clientName: this.name,
      rateLimit: data,
    };
    await this.redis.publish(
      `${this.requestHandlerRedisName}:rateLimitUpdated`,
      JSON.stringify(updatedData)
    );
  }

  /**
   * This method destroys the client by removing all keys associated with the client from Redis and clearing the interval for adding tokens to the client's bucket.
   */

  public async destroy() {
    this.removeAddTokensInterval();
    this.removeHealthCheckInterval();
    this.emitter.off(
      `${this.redisName}:processRequests`,
      processRequests.bind(this)
    );
    this.logger.info(`Client ${this.name} | Destroyed`);
  }

  protected removeAddTokensInterval() {
    if (!this.addTokensInterval) return;
    clearInterval(this.addTokensInterval);
    this.addTokensInterval = undefined;
  }

  protected removeHealthCheckInterval() {
    if (!this.healthCheckInterval) return;
    clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
  }

  /**
   * Adds an interval to the Client so that tokens will be added to the Client's bucket as specified by the rate limit.
   */

  protected startAddTokensInterval() {
    this.removeAddTokensInterval();
    if (this.rateLimit.type !== "requestLimit" || this.role === "worker") {
      return;
    }
    this.addTokensInterval = setInterval(
      async () => await this.addTokens(),
      this.rateLimit.interval
    );
  }

  /**
   * Adds tokens to the client's bucket as specified by the rate limit.
   *
   * This method only runs if the rate limit is a requestLimit type and the client is not frozen.
   *
   * If there are less than 0 tokens in the client's bucket, the method will set the number of tokens to 0.
   *
   * If there are more tokens in the client's bucket than the max allowed, the method will set the number of tokens to the max allowed.
   *
   * If the client's bucket is full, the method will not add any tokens.
   *
   * If the client's bucket is not full, the method will add tokens to the client's bucket and emit a tokensAdded event.
   *
   * @param cost The cost of the request. If the cost is not provided, the method will add 1 token to the client's bucket.
   *
   */

  protected async addTokens(cost?: number) {
    if (this.rateLimit.type === "noLimit") return;
    if (this.freezeTimeout && this.rateLimit.type === "requestLimit") return;
    if (this.tokens === this.maxTokens) return;
    else if (this.tokens < 0) this.tokens = 0;
    else if (this.tokens > this.maxTokens) this.tokens = this.maxTokens;
    else {
      const tokensToAdd = cost || this.tokensToAdd;
      if (tokensToAdd + this.tokens > this.maxTokens) {
        this.tokens = this.maxTokens;
      } else this.tokens += tokensToAdd;
      this.emitter.emit(`${this.redisName}:tokensAdded`, this.tokens);
    }
    await this.redis.set(`${this.redisName}:tokens`, this.tokens);
  }

  public handleRateLimitUpdated(data: ClientTypes.RateLimitUpdatedData) {
    this.rateLimit = data.rateLimit;
    this.createData = { ...this.createData, rateLimit: data.rateLimit };
    if (this.role === "worker") return;
    this.startAddTokensInterval();
  }

  public handleRequestAdded(request: RequestMetadata) {
    if (this.role === "worker") return;
    this.requestsInQueue.set(request.requestId, request);
    this.hasUnsortedRequests = true;
    this.emitter.emit(`${this.redisName}:processRequests`);
  }

  public async handleRequestDone(data: RequestDoneData) {
    if (this.role === "worker") return;
    this.requestsInProgress.delete(data.requestId);
    if (data.waitTime) await this.handleFreezeRequests(data);
    if (this.rateLimit.type === "concurrencyLimit") {
      await this.addTokens(data.cost);
    }
    if (data.requestId !== this.thawRequestId) return;
    if (data.status === "success") this.thawRequestCount--;
    this.thawRequestId = undefined;
  }

  private async handleFreezeRequests(data: RequestDoneData) {
    this.logger.debug(`Freezing requests for ${data.waitTime}ms...`);
    if (this.rateLimit.type === "requestLimit") {
      this.tokens = 0;
      await this.redis.set(`${this.redisName}:tokens`, 0);
    }
    if (this.freezeTimeout) clearTimeout(this.freezeTimeout);
    if (data.isRateLimited) {
      this.thawRequestCount = this.retryOptions.thawRequestCount;
    }
    this.freezeTimeout = setTimeout(() => {
      this.freezeTimeout = undefined;
      if (this.rateLimit.type === "noLimit") return;
      this.emitter.emit(`${this.redisName}:processRequests`);
    }, data.waitTime);
  }

  public async getStats(): Promise<ClientTypes.ClientStatistics> {
    const tokens = await this.redis.get(`${this.redisName}:tokens`);
    const requestsInQueue = await this.redis.smembers(
      `${this.redisName}:queue`
    );
    const requestsInProgress = await this.redis.smembers(
      `${this.redisName}:inProgress`
    );
    return {
      clientName: this.name,
      tokens: tokens ? parseInt(tokens) : 0,
      maxTokens: this.maxTokens,
      requestsInQueue: requestsInQueue.length,
      requestsInProgress: requestsInProgress.length,
    };
  }
}
