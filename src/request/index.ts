import { RequestOptions } from "../client/types";
import * as RequestTypes from "./types";
import { v4 } from "uuid";

export default class Request {
  public id: string;
  public config: RequestTypes.RequestConfig;
  public retries: number;
  private priority: number;
  private clientName: string;
  private timestamp: number;
  private cost: number;

  constructor(
    clientName: string,
    config: RequestTypes.RequestConfig,
    requestOptions?: RequestOptions
  ) {
    this.id = v4();
    this.timestamp = Date.now();
    this.priority = config.priority || 1;
    this.cost = config.cost || 1;
    this.retries = 0;
    this.config = config;
    this.clientName = clientName;
    if (requestOptions?.defaults) {
      const { headers, baseURL, params } = requestOptions.defaults;
      this.config = {
        ...this.config,
        baseURL: baseURL || this.config.baseURL,
        headers: { ...this.config.headers, ...(headers || {}) },
        params: { ...this.config.params, ...(params || {}) },
      };
    }
  }

  incrementRetries() {
    this.retries++;
  }

  getMetadata(): RequestTypes.RequestMetadata {
    return {
      requestId: this.id,
      clientName: this.clientName,
      timestamp: this.timestamp,
      priority: this.priority,
      cost: this.cost,
      retries: this.retries,
    };
  }

  getRequestDoneData(
    retryData?: RequestTypes.RequestRetryData
  ): RequestTypes.RequestDoneData {
    return {
      ...this.getMetadata(),
      status: retryData ? "failure" : "success",
      waitTime: retryData?.waitTime || 0,
      isRateLimited: retryData?.isRateLimited || false,
    };
  }
}
