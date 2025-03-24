import { RateLimitData } from "../client/types";
import BaseError from "../baseError";
import { AxiosError } from "axios";
import { Logger } from "winston";
import Client from "../client";
import { v4 } from "uuid";
import {
  RequestConfig,
  RequestDefaults,
  RequestInterceptor,
  ResponseInterceptor,
  RetryOptions,
} from "./types";

export default class Request {
  public id: string;
  private client: Client;
  private config: RequestConfig;
  private retryOptions: RetryOptions;
  private rateLimit: RateLimitData;
  private httpStatusCodesToMute?: number[];
  private defaults?: RequestDefaults;
  private requestInterceptor?: RequestInterceptor;
  private responseInterceptor?: ResponseInterceptor;
  private logger: Logger;
  private retries = 0;

  constructor(client: Client, config: RequestConfig, logger: Logger) {
    const { requestOptions: options } = client;
    this.id = v4();
    this.client = client;
    this.rateLimit = client.rateLimit;
    this.httpStatusCodesToMute = options?.httpStatusCodesToMute;
    this.config = config;
    this.logger = logger;
    this.defaults = options?.defaults;
    this.requestInterceptor = options?.requestInterceptor;
    this.responseInterceptor = options?.responseInterceptor;
    this.retryOptions = {
      maxRetries: options?.retryOptions?.maxRetries || 3,
      retry429s: options?.retryOptions?.retry429s || true,
      retry5xxs: options?.retryOptions?.retry5xxs || true,
      retryBackoffBaseTime: options?.retryOptions?.retryBackoffBaseTime || 1000,
      retryBackoffMethod:
        options?.retryOptions?.retryBackoffMethod || "exponential",
      retryHandler: options?.retryOptions?.retryHandler,
      retryStatusCodes: options?.retryOptions?.retryStatusCodes || [],
    };
  }

  /**
   * This method sends the request and handles retries and rate limiting.
   *
   * Order of operations:
   * 1. Apply any request defaults to the request config.
   * 2. Get a token from the client.
   * 3. If a request interceptor is present, call it and update the config.
   * 4. If an authenticator is present, authenticate the request.
   * 5. Send the request.
   * 6. If the response interceptor is present, call it.
   * 7. Log the response status.
   */

  async send() {
    this.handleRequestDefaults(this.defaults);
    this.debug(
      `${this.config.method} | ${this.config.baseURL || ""}${
        this.config.url || ""
      }`
    );
    let response;
    do {
      await this.client.waitForRequestReady(this.id, this.config, this.retries);
      if (this.requestInterceptor) {
        this.config = await this.requestInterceptor(this.config);
      }
      if (this.client.authenticator) {
        const authHeader = await this.client.authenticator.authenticate(
          this.config
        );
        this.config = {
          ...this.config,
          headers: { ...this.config.headers, ...authHeader },
        };
      }
      try {
        response = await this.client.sendRequest(this.config);
        await this.client.handleResponse(this.id, this.config, response);
      } catch (error: any) {
        if (this.retries === this.retryOptions.maxRetries) {
          throw new BaseError(
            this.logger,
            "Maximum number of retries reached.",
            {
              context: this.id,
              error: {
                message: error.message,
                stack: error.stack,
                code: error.code,
                config: error.config,
                response: {
                  status: error.response?.status,
                  statusText: error.response?.statusText,
                  headers: error.response?.headers,
                  data: error.response?.data,
                },
              },
            }
          );
        }
        const shouldRetry = await this.handleError(error);
        await this.client.handleResponse(this.id, this.config, error);
        if (shouldRetry) this.retries++;
        else throw error;
      }
    } while (!response && this.retries <= this.retryOptions.maxRetries);
    if (!response) {
      throw new BaseError(this.logger, "No response received for the request.");
    }
    if (this.responseInterceptor) {
      await this.responseInterceptor(this.config, response);
    }
    this.debug(`Response: ${response.status}`);
    return response;
  }

  /**
   * Adds the request defaults to the request config.
   *
   * @param request A Request instance.
   * @returns
   */

  private handleRequestDefaults(defaults?: RequestDefaults) {
    if (!defaults) return;
    const { headers, baseURL, params } = defaults;
    if (headers) {
      this.config = {
        ...this.config,
        headers: { ...this.config.headers, ...headers },
      };
    }
    if (baseURL) this.config = { ...this.config, baseURL };
    if (params) {
      this.config = {
        ...this.config,
        params: { ...params, ...this.config.params },
      };
    }
  }

  /**
   * Handles errors for each request and determines if the request should be retried.
   *
   * Order of operations:
   * 1. If 429 and retry429s is true, handle the 429 and retry.
   * 2. If 5xx or if the error code in in the retryableCodes list, and if retry5xxs is true, handle the error and retry.
   * 3. If the status code is in the retryStatusCodes array, handle the error and retry.
   * 4. If client has a retryHandler, call it and retry if it returns true.
   * 5. Otherwise, do not retry.
   *
   * @param request A Request instance.
   * @param error The error object.
   * @returns
   */
  private async handleError(error: AxiosError) {
    const status: number | undefined = error.response?.status;
    const code: string | undefined = error.code;
    const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"];
    const logger =
      status && this.httpStatusCodesToMute?.includes(status)
        ? this.debug.bind(this)
        : this.error.bind(this);
    logger(`Request failed with status ${status} and code ${code}`, {
      response: {
        status: status,
        headers: error.response?.headers,
        data: error.response?.data,
      },
    });
    if (status && status === 429 && this.retryOptions.retry429s) {
      return await this.handleBackoff("Rate Limited");
    } else if (
      ((status && status >= 500) || (code && retryableCodes.includes(code))) &&
      this.retryOptions.retry5xxs
    ) {
      return await this.handleBackoff("Server Error");
    } else if (
      status &&
      this.retryOptions?.retryStatusCodes?.includes(status)
    ) {
      return await this.handleBackoff("Client Wants Retry Status");
    } else if (this.retryOptions.retryHandler) {
      const retry = await this.retryOptions.retryHandler(error);
      if (retry) return await this.handleBackoff("Client Wants Retry");
      else return false;
    } else return false;
  }

  /**
   * This method handles the backoff for the request including how long to wait before retrying and request freezing.
   *
   * @param type The reason for the backoff.
   * @returns
   */

  private async handleBackoff(type: string) {
    const retryMessage =
      this.retries >= this.retryOptions.maxRetries
        ? "No more retries"
        : `Attempt ${this.retries + 1} | Retrying...`;
    const backoffBase =
      (this.rateLimit.type === "requestLimit" && this.rateLimit.interval) ||
      this.retryOptions.retryBackoffBaseTime;
    const power =
      this.retryOptions.retryBackoffMethod === "exponential" ? 2 : 1;
    const waitTime = Math.pow(this.retries + 1, power) * backoffBase;
    await this.client.freezeRequests(waitTime, type === "Rate Limited");
    this.debug(`${type} | ${retryMessage}`);
    return true;
  }

  /**
   * Created a debug log.
   *
   * @param message The message to log.
   * @param data The data to log in metadata.
   */

  private debug(message: string, data?: any) {
    this.logger.debug(`Request ID: ${this.id} | ${message}`, data);
  }

  /**
   * Created an error log.
   *
   * @param message The message to log.
   * @param data The data to log in metadata.
   */

  private error(message: string, data?: any) {
    this.logger.error(`Request ID: ${this.id} | ${message}`, data);
  }
}
