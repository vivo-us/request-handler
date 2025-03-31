import { AxiosResponse, CreateAxiosDefaults } from "axios";
import { AuthCreateData } from "../authenticator/types";
import { RequestConfig } from "../request/types";
import EventEmitter from "events";
import { Logger } from "winston";
import IORedis from "ioredis";

export type ClientRole = "master" | "slave";

export type ClientGenerator = () =>
  | Promise<CreateClientData[]>
  | CreateClientData[];

export type RateLimitChange = (
  oldRateLimit: RateLimitData,
  response: AxiosResponse
) => Promise<RateLimitData | undefined> | RateLimitData | undefined;

export interface ClientConstructorData {
  client: CreateClientData;
  redis: IORedis;
  requestHandlerRedisName: string;
  logger: Logger;
  key: string;
  emitter: EventEmitter;
}

export interface CreateClientData {
  /** The name of the client */
  name: string;
  /**
   * The Rate Limit info for the Client
   *
   * Defaults to no limit
   */
  rateLimit?: RateLimitData;
  /**
   * A function to take the old rate limit and the response of a request and see if the rate limit should change
   *
   * Should return a new rate limit object if the rate limit should change, otherwise return undefined
   */
  rateLimitChange?: RateLimitChange;
  /** The client to share a rate limit with */
  sharedRateLimitClientName?: string;
  /** Options to pass to each request */
  requestOptions?: RequestOptions;
  /** Options to configure the retry behavior of the request handler. */
  retryOptions?: Partial<RetryOptions>;
  /** Any HTTP status code included in this array will result in a debug log rather than an error log */
  httpStatusCodesToMute?: number[];
  /** Optional object for storing other data with the updater */
  metadata?: { [key: string]: any };
  /**
   * Options to pass to the created Axios instance
   */
  axiosOptions?: CreateAxiosDefaults;
  /**
   * Optional authentication data so the client can automatically authenticate requests
   */
  authentication?: AuthCreateData;
  /**
   * Clients that will use the same endpoints/authentication/etc as the parent client
   */
  subClients?: CreateClientData[];
}

export interface RateLimitUpdatedData {
  clientName: string;
  rateLimit: RateLimitData;
}

export type RateLimitData =
  | RequestLimitClient
  | ConcurrencyLimitClient
  | NoLimitClient;

export interface NoLimitClient {
  type: "noLimit";
}

export interface RequestLimitClient {
  type: "requestLimit";
  /** The number of ms between adding more tokens */
  interval: number;
  /** How many tokens to add per interval */
  tokensToAdd: number;
  /** The maximum number of tokens the client's bucket is allows to hold */
  maxTokens: number;
}

export interface ConcurrencyLimitClient {
  type: "concurrencyLimit";
  /** Maximum number of concurrent requests allowed */
  maxConcurrency: number;
}

export interface RequestMetadata {
  priority: number;
  timestamp: number;
  requestId: string;
  clientName: string;
  cost: number;
  retries: number;
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
   * Default values to set for each request
   */
  defaults?: RequestDefaults;
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
  retryStatusCodes: number[];
  /**
   * The number of requests in a row must come back with a 2xx status to start sending requests at full speed again after a rate limit has been breached
   *
   * **Default value: 3**
   */
  thawRequestCount: number;
}

export interface RequestDefaults {
  /** The default headers to set for each request */
  headers?: Record<string, string>;
  /** The base URL to use for each request */
  baseURL?: string;
  /** The default params to include with each request */
  params?: Record<string, string>;
}

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

export interface RequestDoneData {
  cost: number;
  status: "success" | "failure";
  requestId: string;
  clientName: string;
  waitTime: number;
  isRateLimited: boolean;
}

export interface RequestRetryData {
  retry: boolean;
  message: string;
  isRateLimited: boolean;
  waitTime: number;
}
