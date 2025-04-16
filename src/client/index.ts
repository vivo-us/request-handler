import { RequestDoneData, RequestMetadata } from "../request/types";
import { Authenticator } from "../authenticator";
import processRequests from "./processRequests";
import axios, { AxiosInstance } from "axios";
import handleRequest from "./handleRequest";
import * as ClientTypes from "./types";
import { Logger } from "winston";
import IORedis from "ioredis";
import { v4 } from "uuid";

export default class Client {
  protected id: string = v4();
  protected name: string;
  protected role: ClientTypes.ClientRole = "worker";
  protected http: AxiosInstance;
  protected redis: IORedis;
  protected redisName: string;
  protected emitter: NodeJS.EventEmitter;
  protected logger: Logger;
  protected rateLimit: ClientTypes.CreatedRateLimit;
  protected metadata?: { [key: string]: any };
  protected requestOptions: ClientTypes.RequestOptions;
  protected authenticator?: Authenticator;
  protected retryOptions: ClientTypes.RetryOptions;
  protected rateLimitChange?: ClientTypes.RateLimitChange;
  protected requestHandlerRedisName: string;
  protected healthCheckIntervalMs: number;
  protected healthCheckInterval?: NodeJS.Timeout;
  protected hasUnsortedRequests: boolean = false;
  protected requests: Map<string, RequestMetadata> = new Map();
  protected requestsHeartbeat: Map<string, NodeJS.Timeout> = new Map();
  protected httpStatusCodesToMute: number[];
  protected freezeTimeout?: NodeJS.Timeout;
  protected thawRequestCount: number = 0;
  protected thawRequestId?: string;
  protected processingId?: string;

  public handleRequest = handleRequest.bind(this);
  protected processRequests = processRequests.bind(this);

  constructor(data: ClientTypes.ClientConstructorData) {
    this.emitter = data.emitter;
    this.http = axios.create(data.client.axiosOptions);
    this.logger = data.logger;
    this.redis = data.redis;
    this.name = data.client.name;
    if (!data.client.rateLimit) this.rateLimit = { type: "noLimit" };
    else if (data.client.rateLimit.type === "requestLimit") {
      this.rateLimit = {
        ...data.client.rateLimit,
        tokens: data.client.rateLimit.maxTokens,
      };
    } else this.rateLimit = data.client.rateLimit;
    this.requestHandlerRedisName = data.requestHandlerRedisName;
    this.redisName = `${data.requestHandlerRedisName}:${(this.rateLimit.type ===
    "shared"
      ? this.rateLimit.clientName
      : data.client.name
    ).replaceAll(/ /g, "_")}`;
    this.healthCheckIntervalMs = data.client.healthCheckIntervalMs || 10000;
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
    if (this.rateLimit.type === "shared") return;
    await this.updateRateLimit(this.rateLimit);
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

  public getName() {
    return this.name;
  }

  public getRole() {
    return this.role;
  }

  public getRateLimit() {
    return this.rateLimit;
  }

  /**
   * This method ensures that all proper actions are taken based on the role of the client.
   *
   * Always clears the addTokensInterval and healthCheckInterval if they are running.
   *
   * If the client is a worker, no further action is taken.
   *
   * If the client has the controller role, it will take the following actions:
   * - Start the addTokensInterval
   * - Emit the processRequests event
   *
   *
   */

  public updateRole(role: ClientTypes.ClientRole) {
    if (role === this.role) return;
    this.role = role;
    this.startHealthCheckInterval();
    this.startAddTokensInterval();
    this.processRequests();
  }

  private startHealthCheckInterval(this: Client) {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      for (const key of this.requests.keys()) {
        if (this.requestsHeartbeat.has(key)) continue;
        this.requests.delete(key);
      }
      if (
        this.rateLimit.type === "requestLimit" &&
        !this.rateLimit.addTokensInterval
      ) {
        this.startAddTokensInterval();
      }
    }, this.healthCheckIntervalMs);
  }

  private removeAddTokensInterval() {
    if (this.rateLimit.type !== "requestLimit") return;
    if (!this.rateLimit.addTokensInterval) return;
    clearInterval(this.rateLimit.addTokensInterval);
    this.rateLimit.addTokensInterval = undefined;
  }

  /**
   * Adds an interval to the Client so that tokens will be added to the Client's bucket as specified by the rate limit.
   */

  private startAddTokensInterval() {
    if (this.role === "worker" || this.rateLimit.type !== "requestLimit") {
      return;
    }
    this.removeAddTokensInterval();
    this.rateLimit.addTokensInterval = setInterval(
      () => this.addTokens(),
      this.rateLimit.interval
    );
  }

  private removeHealthCheckInterval() {
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

  private async addTokens() {
    if (this.rateLimit.type !== "requestLimit") return;
    const { maxTokens, tokensToAdd, tokens } = this.rateLimit;
    if (tokens === maxTokens || this.freezeTimeout) return;
    else if (tokens < 0) this.rateLimit.tokens = 0;
    else if (tokens > maxTokens) this.rateLimit.tokens = maxTokens;
    else {
      const isOver = tokensToAdd + tokens > maxTokens;
      if (isOver) this.rateLimit.tokens = maxTokens;
      else this.rateLimit.tokens += tokensToAdd;
      this.emitter.emit(`${this.redisName}:tokensAdded`, this.rateLimit.tokens);
      await this.redis.publish(
        `${this.requestHandlerRedisName}:clientTokensUpdated`,
        JSON.stringify({ clientName: this.name, tokens: this.rateLimit.tokens })
      );
    }
  }

  public async handleTokensUpdated(data: ClientTypes.ClientTokensUpdatedData) {
    if (this.rateLimit.type !== "requestLimit" || this.id === data.clientId) {
      return;
    }
    this.rateLimit.tokens = data.tokens;
  }

  public handleRateLimitUpdated(data: ClientTypes.RateLimitUpdatedData) {
    if (data.rateLimit.type === "requestLimit") {
      if (this.rateLimit.type !== "requestLimit") {
        this.rateLimit = {
          ...data.rateLimit,
          tokens: data.rateLimit.maxTokens,
        };
      } else {
        this.rateLimit = {
          ...data.rateLimit,
          tokens:
            this.rateLimit.tokens > data.rateLimit.maxTokens
              ? data.rateLimit.maxTokens
              : this.rateLimit.tokens,
        };
      }
    } else this.rateLimit = data.rateLimit;
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
    if (this.role === "worker") this.requests.set(request.requestId, request);
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
    if (data.waitTime) this.handleFreezeRequests(data);
    if (this.rateLimit.type === "concurrencyLimit") {
      this.emitter.emit(`${this.redisName}:requestDone`);
    }
    if (data.requestId !== this.thawRequestId) return;
    if (data.responseStatus === "success") this.thawRequestCount--;
    this.thawRequestId = undefined;
    this.processRequests();
  }

  private handleFreezeRequests(data: RequestDoneData) {
    this.logger.debug(`Freezing requests for ${data.waitTime}ms...`);
    if (this.rateLimit.type === "requestLimit") this.rateLimit.tokens = 0;
    if (this.freezeTimeout) clearTimeout(this.freezeTimeout);
    if (data.isRateLimited) {
      this.thawRequestCount = this.retryOptions.thawRequestCount;
    }
    this.freezeTimeout = setTimeout(() => {
      this.freezeTimeout = undefined;
      this.processRequests();
    }, data.waitTime);
  }

  public getStats(): ClientTypes.ClientStatistics {
    let rateLimit: ClientTypes.CreatedRateLimit;
    if (this.rateLimit.type === "requestLimit") {
      rateLimit = {
        type: "requestLimit",
        tokens: this.rateLimit.tokens,
        maxTokens: this.rateLimit.maxTokens,
        interval: this.rateLimit.interval,
        tokensToAdd: this.rateLimit.tokensToAdd,
      };
    } else rateLimit = this.rateLimit;
    const stats: ClientTypes.ClientStatistics = {
      clientName: this.name,
      isFrozen: this.freezeTimeout !== undefined,
      isThawing: this.thawRequestId !== undefined,
      thawRequestCount: this.thawRequestCount,
      rateLimit,
      requestsInQueue: { count: 0, cost: 0, requests: [] },
      requestsInProgress: { count: 0, cost: 0, requests: [] },
    };
    for (const request of this.requests.values()) {
      if (request.status === "inQueue") {
        stats.requestsInQueue.count++;
        stats.requestsInQueue.cost += request.cost;
        stats.requestsInQueue.requests.push(request);
      } else {
        stats.requestsInProgress.count++;
        stats.requestsInProgress.cost += request.cost;
        stats.requestsInProgress.requests.push(request);
      }
    }
    return stats;
  }
}
