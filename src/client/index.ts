import waitForRequestReady from "./waitForRequestReady";
import handleRedisMessage from "./handleRedisMessage";
import { Authenticator } from "../authenticator";
import processRequests from "./processRequests";
import handleResponse from "./handleResponse";
import axios, { AxiosInstance } from "axios";
import handleRequest from "./handleRequest";
import * as ClientTypes from "./types";
import updateRole from "./updateRole";
import EventEmitter from "events";
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
  protected rateLimitChange?: ClientTypes.RateLimitChange;
  protected http: AxiosInstance;
  protected id: string = v4();
  protected role: ClientTypes.ClientRole = "slave";
  protected redis: IORedis;
  protected redisListener: IORedis;
  protected redisName: string;
  protected interval?: NodeJS.Timeout;
  protected hasUnsortedRequests: boolean = false;
  protected pendingRequests: Map<string, ClientTypes.RequestMetadata> =
    new Map();
  protected emitter: NodeJS.EventEmitter = new EventEmitter();
  protected logger: Logger;
  protected tokens: number = 0;
  protected freezeTimeout?: NodeJS.Timeout;
  protected thawRequestCount: number = 0;
  protected thawRequestId?: string;
  protected processingId?: string;

  public handleRequest = handleRequest.bind(this);
  public updateRole = updateRole.bind(this);
  private processRequests = processRequests.bind(this);
  private handleRedisMessage = handleRedisMessage.bind(this);
  protected handleResponse = handleResponse.bind(this);
  protected waitForRequestReady = waitForRequestReady.bind(this);

  constructor(data: ClientTypes.ClientConstructorData) {
    this.http = axios.create(data.client.axiosOptions);
    this.logger = data.logger;
    this.redis = data.redis;
    this.redisListener = data.redis.duplicate().setMaxListeners(4);
    this.name = data.client.name;
    this.createData = data.client;
    this.redisName = `${data.requestHandlerRedisName}:${(
      data.client.sharedRateLimitClientName || data.client.name
    ).replaceAll(/ /g, "_")}`;
    this.rateLimit = data.client.rateLimit || { type: "noLimit" };
    if (this.rateLimit.type === "concurrencyLimit") {
      this.tokens = this.rateLimit.maxConcurrency;
    } else if (this.rateLimit.type === "requestLimit") {
      this.tokens = this.rateLimit.maxTokens;
    }
    this.metadata = data.client.metadata;
    this.requestOptions = data.client.requestOptions || {};
    this.rateLimitChange = data.client.rateLimitChange;
    this.emitter.on("processRequests", this.processRequests.bind(this));
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
    await this.redisListener.subscribe(
      `${this.redisName}:${this.id}:requestReady`,
      `${this.redisName}:rateLimitUpdated`
    );
    this.redisListener.on("message", this.handleRedisMessage.bind(this));
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

  /**
   * Updates the rate limit data for the client in Redis and publishes the new rate limit data to the requestHandler so that other nodes can update their clients.
   *
   * @param data The new rate limit data
   */

  protected async updateRateLimit(data: ClientTypes.RateLimitData) {
    await this.redis.set(`${this.redisName}:rateLimit`, JSON.stringify(data));
    await this.redis.publish(
      `${this.redisName}:rateLimitUpdated`,
      JSON.stringify(data)
    );
  }

  /**
   * Adds an interval to the Client so that tokens will be added to the Client's bucket as specified by the rate limit.
   */

  protected addInterval() {
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

  protected addTokens(cost?: number) {
    if (this.rateLimit.type === "noLimit") return;
    if (this.freezeTimeout && this.rateLimit.type === "requestLimit") return;
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
}
