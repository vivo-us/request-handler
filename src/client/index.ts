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
  public role: ClientTypes.ClientRole = "worker";
  protected authenticator?: Authenticator;
  protected createData: ClientTypes.CreateClientData;
  protected retryOptions: ClientTypes.RetryOptions;
  protected rateLimitChange?: ClientTypes.RateLimitChange;
  protected http: AxiosInstance;
  protected id: string = v4();
  protected redis: IORedis;
  protected requestHandlerRedisName: string;
  protected redisName: string;
  protected addTokensInterval?: NodeJS.Timeout;
  protected healthCheckInterval?: NodeJS.Timeout;
  protected hasUnsortedRequests: boolean = false;
  protected requests: Map<string, RequestMetadata> = new Map();
  protected requestsHeartbeat: Map<string, NodeJS.Timeout> = new Map();
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
  protected processRequests = processRequests.bind(this);

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
      retryHandler: retryOptions?.retryHandler,
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
    if (this.createData.sharedRateLimitClientName) return;
  }

  /**
   * Updates the rate limit data for the client in Redis and publishes the new rate limit data to the requestHandler so that other instances can update their clients.
   *
   * @param data The new rate limit data
   */

  protected async updateRateLimit(data: ClientTypes.RateLimitData) {
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

  public destroy() {
    this.removeAddTokensInterval();
    this.removeHealthCheckInterval();
    this.logger.info(`Client ${this.name} | Destroyed`);
  }

  protected removeAddTokensInterval() {
    if (!this.addTokensInterval) return;
    clearInterval(this.addTokensInterval);
    this.addTokensInterval = undefined;
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
      () => this.addTokens(),
      this.rateLimit.interval
    );
  }

  protected removeHealthCheckInterval() {
    if (!this.healthCheckInterval) return;
    clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
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

  protected addTokens(cost?: number) {
    if (this.rateLimit.type === "noLimit") return;
    if (this.freezeTimeout && this.rateLimit.type === "requestLimit") return;
    if (this.tokens === this.maxTokens) return;
    else if (this.tokens < 0) this.tokens = 0;
    else if (this.tokens > this.maxTokens) this.tokens = this.maxTokens;
    else {
      const tokensToAdd = cost || this.tokensToAdd;
      const requestsInProgresscost = this.getRequestsInProgressCost();
      if (
        this.rateLimit.type === "requestLimit" &&
        tokensToAdd + this.tokens > this.maxTokens
      ) {
        this.tokens = this.maxTokens;
      } else if (
        this.rateLimit.type === "concurrencyLimit" &&
        tokensToAdd + this.tokens + requestsInProgresscost > this.maxTokens
      ) {
        this.tokens = this.maxTokens - requestsInProgresscost;
      } else this.tokens += tokensToAdd;
      this.emitter.emit(`${this.redisName}:tokensAdded`, this.tokens);
    }
  }

  protected getRequestsInProgressCost() {
    let cost = 0;
    for (const request of this.requests.values()) {
      if (request.status !== "inProgress") continue;
      cost += request.cost;
    }
    return cost;
  }

  public handleRateLimitUpdated(data: ClientTypes.RateLimitUpdatedData) {
    this.rateLimit = data.rateLimit;
    this.createData = { ...this.createData, rateLimit: data.rateLimit };
    if (this.role === "worker") return;
    this.startAddTokensInterval();
  }

  public handleRequestAdded(request: RequestMetadata) {
    this.requests.set(request.requestId, request);
    this.requestsHeartbeat.set(
      request.requestId,
      setTimeout(() => this.handleRequestDied(request.requestId), 3000)
    );
    this.hasUnsortedRequests = true;
    if (this.role === "worker") return;
    this.processRequests();
  }

  private handleRequestDied(requestId: string) {
    this.requests.delete(requestId);
    const heartbeat = this.requestsHeartbeat.get(requestId);
    if (heartbeat) {
      clearTimeout(heartbeat);
      this.requestsHeartbeat.delete(requestId);
    }
  }

  public handleRequestHeartbeat(request: RequestMetadata) {
    const heartbeat = this.requestsHeartbeat.get(request.requestId);
    if (heartbeat) heartbeat.refresh();
    else this.handleRequestAdded(request);
  }

  public handleRequestReady(request: RequestMetadata) {
    this.emitter.emit(`requestReady:${request.requestId}`, request);
  }

  public handleRequestDone(data: RequestDoneData) {
    this.requests.delete(data.requestId);
    const heartbeat = this.requestsHeartbeat.get(data.requestId);
    if (heartbeat) {
      clearTimeout(heartbeat);
      this.requestsHeartbeat.delete(data.requestId);
    }
    if (this.role === "worker") return;
    if (this.rateLimit.type === "concurrencyLimit") this.addTokens(data.cost);
    if (data.waitTime) this.handleFreezeRequests(data);
    if (data.requestId !== this.thawRequestId) return;
    if (data.responseStatus === "success") this.thawRequestCount--;
    this.thawRequestId = undefined;
    this.processRequests();
  }

  private handleFreezeRequests(data: RequestDoneData) {
    this.logger.debug(`Freezing requests for ${data.waitTime}ms...`);
    if (this.rateLimit.type === "requestLimit") this.tokens = 0;
    if (this.freezeTimeout) clearTimeout(this.freezeTimeout);
    if (data.isRateLimited) {
      this.thawRequestCount = this.retryOptions.thawRequestCount;
    }
    this.freezeTimeout = setTimeout(() => {
      this.freezeTimeout = undefined;
      if (this.rateLimit.type === "noLimit") return;
      this.processRequests();
    }, data.waitTime);
  }

  public getStats(): ClientTypes.ClientStatistics {
    const stats: ClientTypes.ClientStatistics = {
      clientName: this.name,
      tokens: this.tokens,
      maxTokens: this.maxTokens,
      requestsInQueue: 0,
      requestsInProgress: 0,
    };
    for (const request of this.requests.values()) {
      if (request.status === "inQueue") stats.requestsInQueue++;
      else stats.requestsInProgress++;
    }
    return stats;
  }
}
