import { RequestOptions } from "../client/types";
import { Authenticator } from "../authenticator";
import * as RequestTypes from "./types";
import { AxiosResponse } from "axios";
import { v4 } from "uuid";

export default class Request {
  public id: string;
  public config: RequestTypes.RequestConfig;
  public retries = 0;
  public metadata: RequestTypes.RequestMetadata;
  private authenticator?: Authenticator;
  private clientName: string;
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
    this.authenticator = data.authenticator;
    this.clientName = data.clientName;
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

  getRequestDoneData(
    retryData?: RequestTypes.RequestRetryData
  ): RequestTypes.RequestDoneData {
    return {
      cost: this.config.cost || 1,
      status: retryData ? "failure" : "success",
      requestId: this.id,
      clientName: this.clientName,
      waitTime: retryData?.waitTime || 0,
      isRateLimited: retryData?.isRateLimited || false,
    };
  }
}
