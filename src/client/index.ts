import { RequestDoneData, RequestMetadata } from "../request/types";
import processRequests from "./methods/processRequests";
import handleRequest from "./methods/handleRequest";
import axios, { AxiosInstance } from "axios";
import * as ClientTypes from "./types";
import { Logger } from "winston";
import IORedis from "ioredis";
import { v4 } from "uuid";

abstract class BaseClient {
  protected id: string = v4();
  protected name: string;
  protected role: ClientTypes.ClientRole = "worker";
  protected http: AxiosInstance;
  protected redis: IORedis;
  protected redisName: string;
  protected emitter: NodeJS.EventEmitter;
  protected logger: Logger;
  protected abstract rateLimit: ClientTypes.RateLimitData;
  protected metadata?: { [key: string]: any };
  protected requestOptions: ClientTypes.RequestOptions;
  protected authData?: ClientTypes.AuthCreateData;
  protected key: string;
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
    this.name =
      data.client.rateLimit.type === "sharedLimit"
        ? data.client.rateLimit.clientName
        : data.client.name;
    this.requestHandlerRedisName = data.requestHandlerRedisName;
    this.redisName = `${data.requestHandlerRedisName}:${this.name.replaceAll(
      / /g,
      "_"
    )}`;
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
    this.authData = data.client.authentication;
    this.key = data.key;
  }

  public abstract handleTokensUpdated(
    data: ClientTypes.ClientTokensUpdatedData
  ): void;
  public abstract handleRateLimitUpdated(
    data: ClientTypes.RateLimitUpdatedData
  ): Promise<void> | void;
  protected abstract getRateLimitStats(): ClientTypes.RateLimitStats;
  protected abstract handleUpdateRole(role: ClientTypes.ClientRole): void;
  protected abstract handleHealthCheck(): void;
  protected abstract handleOwnTypeRequestDone(data: RequestDoneData): void;
  protected abstract handleFreezeOwnTypeRequests(): void;
  protected abstract getRetryBackoffBaseTime(): number;
  protected abstract waitForTurn(cost: number): Promise<void> | void;
  protected abstract handleDestroy(): void;

  /**
   * This method initializes the client by updating the rate limit and subscribing to channels in Redis.
   */

  public async init() {
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
    this.handleDestroy();
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
    if (this.rateLimit.type === "sharedLimit") role = "worker";
    if (role === this.role) return;
    this.role = role;
    this.startHealthCheckInterval();
    this.handleUpdateRole(role);
    this.processRequests();
  }

  private startHealthCheckInterval() {
    if (this.healthCheckInterval) return;
    this.healthCheckInterval = setInterval(() => {
      for (const key of this.requests.keys()) {
        if (this.requestsHeartbeat.has(key)) continue;
        this.requests.delete(key);
      }
      this.handleHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  private removeHealthCheckInterval() {
    if (!this.healthCheckInterval) return;
    clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
  }

  public handleRequestAdded(request: RequestMetadata) {
    this.requests.set(request.requestId, request);
    this.requestsHeartbeat.set(
      request.requestId,
      setTimeout(() => this.handleRequestDied(request.requestId), 3000)
    );
    this.hasUnsortedRequests = true;
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
    this.handleOwnTypeRequestDone(data);
    if (data.requestId !== this.thawRequestId) return;
    if (data.responseStatus === "success") this.thawRequestCount--;
    this.thawRequestId = undefined;
    this.processRequests();
  }

  private handleFreezeRequests(data: RequestDoneData) {
    this.logger.debug(`Freezing requests for ${data.waitTime}ms...`);
    this.handleFreezeOwnTypeRequests();
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
    const stats: ClientTypes.ClientStatistics = {
      clientName: this.name,
      isFrozen: this.freezeTimeout !== undefined,
      isThawing: this.thawRequestId !== undefined,
      thawRequestCount: this.thawRequestCount,
      rateLimit: this.getRateLimitStats(),
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

export default BaseClient;
