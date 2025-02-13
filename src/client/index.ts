import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import { RequestConfig, RequestOptions } from "../request/types";
import { ClientRole, RequestMetadata } from "./types";
import { Authenticator } from "../authenticator";
import EventEmitter from "events";
import { Logger } from "winston";
import IORedis from "ioredis";
import { v4 } from "uuid";
import {
  ClientConstructorData,
  CreateClientData,
  RateLimitChange,
  RateLimitData,
} from "./types";

export default class Client {
  public name: string;
  public metadata?: { [key: string]: any };
  public requestOptions?: RequestOptions;
  public authenticator?: Authenticator;
  public rateLimit: RateLimitData;
  public createData: CreateClientData;
  private role: ClientRole = "slave";
  private redis: IORedis;
  private redisListener: IORedis;
  private logger: Logger;
  private redisName: string;
  private http: AxiosInstance;
  private interval?: NodeJS.Timeout;
  private rateLimitChange?: RateLimitChange;
  private pendingRequests: RequestMetadata[] = [];
  private tokens: number = 0;
  private freezeEndDate?: Date;
  private processingIds: string[] = [];
  private emitter: NodeJS.EventEmitter = new EventEmitter();

  constructor(data: ClientConstructorData) {
    const { client, redis, logger, key } = data;
    this.http = axios.create(client.axiosOptions);
    this.logger = logger;
    this.redis = redis;
    this.redisListener = data.redisListener;
    this.name = client.name;
    this.createData = client;
    this.redisName = `${data.requestHandlerRedisName}:${(
      client.sharedRateLimitClientName || client.name
    ).replaceAll(/ /g, "_")}`;
    this.rateLimit = client.rateLimit || { type: "noLimit" };
    if (this.rateLimit.type === "concurrencyLimit") {
      this.tokens = this.rateLimit.maxConcurrency;
    } else if (this.rateLimit.type === "requestLimit") {
      this.tokens = this.rateLimit.maxTokens;
    }
    this.metadata = client.metadata;
    this.requestOptions = client.requestOptions;
    this.rateLimitChange = client.rateLimitChange;
    if (!client.authentication) return;
    this.authenticator = new Authenticator(
      client.authentication,
      this.redis,
      this.redisName,
      key
    );
  }

  /**
   * This method initializes the client by updating the rate limit and subscribing to channels in Redis.
   */

  public async init() {
    await this.updateRateLimit(this.rateLimit);
    await this.redisListener.subscribe(`${this.redisName}:freezeRequests`);
    await this.redisListener.subscribe(`${this.redisName}:rateLimitUpdated`);
    await this.redisListener.subscribe(`${this.redisName}:requestAdded`);
    await this.redisListener.subscribe(`${this.redisName}:requestReady`);
    await this.redisListener.subscribe(`${this.redisName}:requestDone`);
    this.redisListener.on("message", this.handleRedisMessage.bind(this));
  }

  /**
   * Updates the rate limit data for the client in Redis and publishes the new rate limit data to the requestHandler so that other nodes can update their clients.
   *
   * @param data The new rate limit data
   */

  private async updateRateLimit(data: RateLimitData) {
    await this.redis.set(`${this.redisName}:rateLimit`, JSON.stringify(data));
    await this.redis.publish(
      `${this.redisName}:rateLimitUpdated`,
      JSON.stringify(data)
    );
  }

  /**
   * Handles messages from Redis.
   *
   * If a message is received on the freezeRequests channel and it is the master node, the client will set a freeze end time, clear its tokens, and wait for the specified amount of time before it clears the freeze.
   *
   * If a message is received on the rateLimitUpdated channel, the client will update its rate limit and reset the interval for adding tokens to the client's bucket.
   *
   * If a message is received on the requestAdded channel, the client will add the request to the pendingRequests array and process the requests.
   *
   * @param channel The channel the message was sent on
   * @param message The message sent
   */

  private async handleRedisMessage(channel: string, message: string) {
    if (channel === `${this.redisName}:freezeRequests`) {
      if (this.role === `slave`) return;
      this.logger.debug(`Freezing requests for ${message}ms...`);
      this.freezeEndDate = new Date(Date.now() + Number(message));
      if (this.rateLimit.type === "requestLimit") this.tokens = 0;
      await this.wait(Number(message));
      this.freezeEndDate = undefined;
    } else if (channel === `${this.redisName}:rateLimitUpdated`) {
      const data = JSON.parse(message);
      this.rateLimit = data;
      this.createData = { ...this.createData, rateLimit: data };
      if (this.role === "slave") return;
      if (this.interval) clearInterval(this.interval);
      this.addInterval();
    } else if (channel === `${this.redisName}:requestAdded`) {
      if (this.role === "slave") return;
      this.pendingRequests.push(JSON.parse(message));
      await this.processRequests();
    } else if (channel === `${this.redisName}:requestReady`) {
      this.emitter.emit(`requestReady:${message}`, message);
    } else if (channel === `${this.redisName}:requestDone`) {
      if (this.rateLimit.type !== "concurrencyLimit") return;
      if (this.role === "slave") return;
      this.addTokens(Number(message));
    } else return;
  }

  /**
   * This method works through the pending requests and processes them in order of priority and timestamp.
   *
   * When a request is at the top of the queue and the client has a token available, the client will remove the request cost and publish the request to the Request's requestReady channel.
   */

  private async processRequests() {
    if (this.processingIds.length > 0) return;
    const id = v4();
    this.processingIds.push(id);
    try {
      do {
        if (this.processingIds.length > 1) {
          const first = this.processingIds[0];
          if (first !== id) {
            this.removeProcessingId(id);
            break;
          }
        }
        if (this.pendingRequests.length === 0) break;
        this.pendingRequests = this.pendingRequests.sort((a, b) => {
          if (a.priority === b.priority) {
            if (a.timestamp === b.timestamp) {
              return a.requestId < b.requestId ? -1 : 1;
            } else return a.timestamp - b.timestamp;
          } else return b.priority - a.priority;
        });
        const request = this.pendingRequests.shift();
        if (!request) return;
        await this.waitForFreeze();
        await this.waitForTokens(request.cost);
        this.tokens -= request.cost || 1;
        await this.redis.publish(
          `${this.redisName}:requestReady`,
          request.requestId
        );
      } while (this.pendingRequests.length > 0);
      this.removeProcessingId(id);
    } catch (e) {
      this.removeProcessingId(id);
      throw e;
    }
  }

  /** This method removes the processing ID from the processingIds array. */

  private removeProcessingId(id: string) {
    this.processingIds = this.processingIds.filter((each) => each !== id);
  }

  /**
   * This method waits for the freeze to end if the client has a freeze.
   */

  private async waitForFreeze() {
    return new Promise(async (resolve) => {
      if (this.freezeEndDate) {
        const freezeTime = this.freezeEndDate.getTime() - Date.now();
        if (freezeTime > 0) await this.wait(freezeTime);
        // If the freeze time has passed, remove the freeze key
        else this.freezeEndDate = undefined;
        resolve(true);
      } else resolve(true);
    });
  }

  /**
   * This method checks for enough tokens in the client's bucket.
   *
   * If the client has enough tokens, the method will resolve immediately.
   *
   * If the client does not have enough tokens, the method will wait for enough tokens to be added to the client's bucket.
   */

  private waitForTokens(cost: number): Promise<boolean> {
    if (this.tokens >= cost) return Promise.resolve(true);
    return new Promise((resolve) => {
      const listener = () => {
        if (this.tokens < cost) return;
        resolve(true);
        this.emitter.off("tokensAdded", listener);
      };
      this.emitter.on("tokensAdded", listener);
    });
  }

  /**
   * Waits for a specified amount of time.
   *
   * @param time The time to wait in milliseconds.
   */
  private wait(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  /**
   * Adds an interval to the Client so that tokens will be added to the Client's bucket as specified by the rate limit.
   */

  private addInterval() {
    if (this.rateLimit.type !== "requestLimit") return;
    this.interval = setInterval(
      async () => this.addTokens(),
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

  private addTokens(cost?: number) {
    if (this.rateLimit.type === "noLimit") return;
    if (this.freezeEndDate && this.rateLimit.type === "requestLimit") return;
    const max =
      this.rateLimit.type === "requestLimit"
        ? this.rateLimit.maxTokens
        : this.rateLimit.maxConcurrency;
    if (this.tokens < 0) this.tokens = 0;
    else if (this.tokens > max) this.tokens = max;
    else if (this.tokens === max) return;
    else {
      const tokensToAdd =
        this.rateLimit.type === "requestLimit"
          ? this.rateLimit.tokensToAdd
          : cost || 1;
      if (tokensToAdd + this.tokens > max) this.tokens = max;
      else this.tokens += tokensToAdd;
      this.emitter.emit("tokensAdded", this.tokens);
    }
  }

  /**
   * This method takes care of actually sending the request, logging the results, adding tokens to the client's bucket, and updating the rate limit if necessary.
   */

  public async sendRequest(config: RequestConfig) {
    let response;
    try {
      response = await this.http.request(config);
    } catch (error: any) {
      await this.handleResponse(config, error);
      throw error;
    }
    await this.handleResponse(config, response);
    return response;
  }

  /**
   * This method adds back concurrency tokens, logs the request and response, and updates the rate limit if necessary.
   */

  private async handleResponse(
    config: RequestConfig,
    res: AxiosResponse | AxiosError | any
  ) {
    await this.redis.publish(
      `${this.redisName}:requestDone`,
      `${config.cost || 1}`
    );
    if (this.isResponse(res) && this.rateLimitChange) {
      const newLimit = await this.rateLimitChange(this.rateLimit, res);
      if (newLimit) await this.updateRateLimit(newLimit);
    }
  }

  /**
   * This method checks if the response is an AxiosResponse.
   */

  private isResponse(
    res: AxiosResponse | AxiosError | any
  ): res is AxiosResponse {
    return res.data !== undefined && res.status !== undefined;
  }

  /**
   * This method waits for the request to be ready to be sent.
   *
   * If the client has no rate limit, the method will resolve immediately.
   *
   * If the client has a rate limit, the method will add the request to the queue and wait for the request to be ready.
   *
   * If the request is not ready within 30 seconds, the method will resolve false.
   */

  public async waitForRequestReady(
    requestId: string,
    config: RequestConfig
  ): Promise<boolean> {
    return new Promise(async (resolve) => {
      if (this.rateLimit.type === "noLimit") {
        resolve(true);
        return;
      }
      await this.addToQueue(requestId, config);
      const interval = setInterval(async () => {
        await this.redis.expire(`${this.redisName}:queue:${requestId}`, 5);
      }, 2500);
      this.emitter.once(`requestReady:${requestId}`, async (message) => {
        clearInterval(interval);
        await this.redis.srem(`${this.redisName}:queue`, requestId);
        await this.redis.del(`${this.redisName}:queue:${requestId}`);
        resolve(true);
      });
      await this.redis.publish(
        `${this.redisName}:requestAdded`,
        JSON.stringify({
          priority: config.priority || 1,
          cost: config.cost || 1,
          timestamp: Date.now(),
          requestId,
        })
      );
    });
  }

  /**
   * Adds the request to the queue and sets the priority, cost, and timestamp.
   */
  private async addToQueue(requestId: string, config: RequestConfig) {
    const writePipeline = this.redis.pipeline();
    writePipeline.sadd(`${this.redisName}:queue`, requestId);
    writePipeline.hset(`${this.redisName}:queue:${requestId}`, {
      priority: config.priority || 1,
      cost: config.cost || 1,
      timestamp: Date.now(),
    });
    writePipeline.expire(`${this.redisName}:queue:${requestId}`, 5);
    await writePipeline.exec();
  }

  /**
   * This method updates the role of the client.
   *
   * If the roles are the same, the method will return immediately.
   *
   * It will then clear the interval for adding tokens and update the role in the API Health Monitor.
   *
   * If the role is master and the rate limit is not noLimit, the method will add an interval and check for existing requests.
   */

  public async updateRole(role: ClientRole) {
    if (role === this.role) return;
    this.role = role;
    if (this.interval) clearInterval(this.interval);
    if (this.role === "slave" || this.rateLimit.type === "noLimit") return;
    this.addInterval();
    await this.checkExistingRequests();
  }

  /**
   * This method checks for existing requests in the Redis queue and processes them.
   *
   * This is to catch any requests that were added while the client was a slave and were not processed by a previous master.
   */

  private async checkExistingRequests() {
    const requests = await this.redis.smembers(`${this.redisName}:queue`);
    for (const each of requests) {
      const request = await this.redis.hgetall(
        `${this.redisName}:queue:${each}`
      );
      if (!request.priority) {
        await this.redis.srem(`${this.redisName}:queue`, each);
      } else {
        this.pendingRequests.push({
          priority: Number(request.priority),
          timestamp: Number(request.timestamp),
          cost: Number(request.cost),
          requestId: each,
        });
      }
    }
    await this.processRequests();
  }

  /**
   * This method sends a message to the freezeRequests channel in Redis to freeze the client for a specified amount of time.
   */

  public async freezeRequests(ms: number) {
    await this.redis.publish(`${this.redisName}:freezeRequests`, ms.toString());
  }

  /**
   * This method destroys the client by removing all keys associated with the client from Redis and clearing the interval for adding tokens to the client's bucket.
   */

  public async destroy() {
    if (this.interval) clearInterval(this.interval);
    const keys = await this.redis.keys(`${this.redisName}*`);
    if (keys.length > 0) await this.redis.del(keys);
    this.redisListener.off("message", this.handleRedisMessage.bind(this));
    await this.redisListener.quit();
    this.logger.info(`Client ${this.name} | Destroyed`);
  }
}
