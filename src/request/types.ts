import { AxiosRequestConfig, AxiosResponse, Method } from "axios";

export type BackoffType = "exponential" | "linear";

/**
 * Function that is called when the request fails
 *
 * Returns TRUE if the request should be retried, FALSE otherwise
 *
 * @param error The error that was thrown
 * @param client The client that threw the error
 */
export type RetryHandler = (error: any) => Promise<boolean> | boolean;

/**
 * Allows the user to intercept the request before it is sent and manipulate it.
 *
 * This is useful for adding headers, changing the URL, etc.
 *
 * **NOTE: This function MUST return a config object**
 *
 * @param request A Request instance
 * @returns
 */
export type RequestInterceptor = (
  config: RequestConfig
) => Promise<RequestConfig> | RequestConfig;

/**
 * Allows the user to intercept the response before it is returned and manipulate it.
 *
 * This is useful for logging, error handling, etc.
 *
 * @param request A Request instance
 * @param response The AxiosResponse object
 */
export type ResponseInterceptor = (
  config: RequestConfig,
  response: AxiosResponse
) => Promise<void> | void;

export interface RequestConfig extends AxiosRequestConfig {
  clientName: "default" | string;
  /**
   * The priority of the request.
   *
   * Requests with a higher priority will be placed at the front of the queue.
   *
   * **Default value: 1**
   */
  priority?: number;
  /**
   * Metadata to be associated with the request.
   */
  metadata?: Record<string, any>;
  method: Method;
}

export interface RequestOptions {
  /**
   * When cleaning up requests, how long until the request is counted as timed-out.
   *
   * Default: 60000 milliseconds (1 minute)
   */
  cleanupTimeout?: number;
  /** Metadata to carry with the request. It is up to the user to validate the metadata */
  metadata?: Record<string, any>;
  /**
   * Options to configure the retry behavior of the request handler.
   */
  retryOptions?: Partial<RetryOptions>;
  /**
   * Default values to set for each request
   */
  defaults?: RequestDefaults;
  /** Any HTTP status code included in this array will result in a debug log rather than an error log */
  httpStatusCodesToMute?: number[];
  /**
   * Allows the user to intercept the request before it is sent and manipulate it.
   *
   * This is useful for adding headers, changing the URL, etc.
   *
   * This is the client's request interceptor. If a global request interceptor is set, it will be called after this one.
   *
   * **NOTE: This function MUST return a config object**
   *
   * @param request A Request instance
   * @returns
   */
  requestInterceptor?: RequestInterceptor;
  /**
   * Allows the user to intercept the response before it is returned and manipulate it.
   *
   * This is useful for logging, error handling, etc.
   *
   * This is the client's response interceptor. If a global response interceptor is set, it will be called after this one.
   *
   * @param request A Request instance
   * @param response The AxiosResponse object
   */
  responseInterceptor?: ResponseInterceptor;
}

export interface RetryOptions {
  /** Max number of times to retry a request.
   *
   * **Default value: 3**
   */
  maxRetries: number;
  /**
   * The base number of ms to wait before retrying a server error (5xx) request
   *
   * **Default value: 1000 ms**
   */
  retryBackoffBaseTime: number;
  /**
   * Backoff method to use when retrying requests
   *
   * **Default value: "exponential"**
   */
  retryBackoffMethod: BackoffType;
  /**
   * Whether or not to automatically retry 429 errors
   *
   * **Defaults to TRUE**
   */
  retry429s: boolean;
  /**
   * Whether or not to automatically retry 5xx errors
   *
   * **Defaults to TRUE**
   */
  retry5xxs: boolean;
  /**
   * Function that is called when the request fails
   *
   * Returns TRUE if the request should be retried, FALSE otherwise
   *
   * @param error The error that was thrown
   * @param client The client that threw the error
   */
  retryHandler?: RetryHandler;
  /** An array of status codes to retry on */
  retryStatusCodes?: number[];
}

export interface RequestDefaults {
  /** The default headers to set for each request */
  headers?: Record<string, string>;
  /** The base URL to use for each request */
  baseURL?: string;
  /** The default params to include with each request */
  params?: Record<string, string>;
}
