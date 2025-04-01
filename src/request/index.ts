import { RequestOptions } from "../client/types";
import { Authenticator } from "../authenticator";
import * as RequestTypes from "./types";
import { AxiosResponse } from "axios";
import IORedis from "ioredis";
import { v4 } from "uuid";

export default class Request {
  public id: string;
  public config: RequestTypes.RequestConfig;
  public retries = 0;
  public metadata: RequestTypes.RequestMetadata;
  private redis: IORedis;
  private authenticator?: Authenticator;
  private requestHandlerRedisName: string;
  private clientName: string;
  private clientRedisName: string;
  private queueKeepAlive?: NodeJS.Timeout;
  private inProgressKeepAlive?: NodeJS.Timeout;
  private requestOptions?: RequestOptions;

  constructor(data: RequestTypes.RequestConstructorData) {
    this.id = v4();
    this.config = data.config;
    this.requestOptions = data.requestOptions;
    if (this.requestOptions?.defaults) {
      const { headers, baseURL, params } = this.requestOptions.defaults;
      this.config = {
        ...this.config,
        baseURL: baseURL || this.config.baseURL,
        headers: { ...this.config.headers, ...(headers || {}) },
        params: { ...this.config.params, ...(params || {}) },
      };
    }
    this.redis = data.redis;
    this.authenticator = data.authenticator;
    this.requestHandlerRedisName = data.requestHandlerRedisName;
    this.clientName = data.clientName;
    this.clientRedisName = data.clientRedisName;
    this.metadata = {
      requestId: this.id,
      clientName: data.clientName,
      timestamp: Date.now(),
      priority: data.config.priority || 1,
      cost: data.config.cost || 1,
      retries: 0,
    };
  }

  async authenticate() {
    if (!this.authenticator) return;
    const authHeader = await this.authenticator.authenticate(this.config);
    this.config = {
      ...this.config,
      headers: { ...this.config.headers, ...authHeader },
    };
  }

  async handleRequestInterceptor() {
    if (!this.requestOptions?.requestInterceptor) return;
    this.config = await this.requestOptions.requestInterceptor(this.config);
  }

  async handleResponseInterceptor(res: AxiosResponse) {
    if (!this.requestOptions?.responseInterceptor) return;
    await this.requestOptions?.responseInterceptor(this.config, res);
  }

  incrementRetries() {
    this.retries++;
    this.metadata.retries = this.retries;
  }

  private toJsonString() {
    return JSON.stringify(this.metadata);
  }

  async addToQueue() {
    const baseKey = `${this.clientRedisName}:queue`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(baseKey, this.id);
    pipeline.set(`${baseKey}:${this.id}`, this.toJsonString());
    pipeline.expire(`${baseKey}:${this.id}`, 1);
    pipeline.publish(
      `${this.requestHandlerRedisName}:requestAdded`,
      this.toJsonString()
    );
    await pipeline.exec();
    this.queueKeepAlive = setInterval(async () => {
      await this.redis.expire(`${baseKey}:${this.id}`, 1);
    }, 500);
  }

  async removeFromQueue() {
    const pipeline = this.redis.pipeline();
    pipeline.srem(`${this.clientRedisName}:queue`, this.id);
    pipeline.del(`${this.clientRedisName}:queue:${this.id}`);
    await pipeline.exec();
    clearInterval(this.queueKeepAlive);
    this.queueKeepAlive = undefined;
  }

  async addToInProgress() {
    const baseKey = `${this.clientRedisName}:inProgress`;
    const pipeline = this.redis.pipeline();
    pipeline.sadd(baseKey, this.id);
    pipeline.set(`${baseKey}:${this.id}`, this.toJsonString());
    pipeline.expire(`${baseKey}:${this.id}`, 1);
    await pipeline.exec();
    this.inProgressKeepAlive = setInterval(async () => {
      await this.redis.expire(`${baseKey}:${this.id}`, 1);
    }, 500);
  }

  async removeFromInProgress(retryData?: RequestTypes.RequestRetryData) {
    const data: RequestTypes.RequestDoneData = {
      cost: this.config.cost || 1,
      status: retryData ? "failure" : "success",
      requestId: this.id,
      clientName: this.clientName,
      waitTime: retryData?.waitTime || 0,
      isRateLimited: retryData?.isRateLimited || false,
    };
    const pipeline = this.redis.pipeline();
    pipeline.srem(`${this.clientRedisName}:inProgress`, this.id);
    pipeline.del(`${this.clientRedisName}:inProgress:${this.id}`);
    pipeline.publish(
      `${this.requestHandlerRedisName}:requestDone`,
      JSON.stringify(data)
    );
    await pipeline.exec();
    clearInterval(this.inProgressKeepAlive);
    this.inProgressKeepAlive = undefined;
  }
}
