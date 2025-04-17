import { RequestConfig, RequestMetadata } from "../request/types";
import { AxiosResponse, CreateAxiosDefaults } from "axios";
import EventEmitter from "events";
import { Logger } from "winston";
import IORedis from "ioredis";

export type ClientRole = "controller" | "worker";

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
  /** Options to pass to each request */
  requestOptions?: RequestOptions;
  /** Options to configure the retry behavior of the request handler. */
  retryOptions?: Partial<RetryOptions>;
  /** Any HTTP status code included in this array will result in a debug log rather than an error log */
  httpStatusCodesToMute?: number[];
  /**
   * How often to run health checks on the client
   *
   * **Default: 60000 ms (60 seconds)**
   */
  healthCheckIntervalMs?: number;
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
  | NoLimitClient
  | SharedLimitClient;

export type CreatedRateLimit =
  | CreatedRequestLimitClient
  | ConcurrencyLimitClient
  | NoLimitClient
  | SharedLimitClient;

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

export interface CreatedRequestLimitClient extends RequestLimitClient {
  /** The number of tokens the client has */
  tokens: number;
  /** The NodeJS Interval for adding tokens at the defined interval */
  addTokensInterval?: NodeJS.Timeout;
}

export interface ConcurrencyLimitClient {
  type: "concurrencyLimit";
  /** Maximum number of concurrent requests allowed */
  maxConcurrency: number;
}

export interface SharedLimitClient {
  type: "shared";
  /** The name of the client to share a rate limit with */
  clientName: string;
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

export interface ClientStatistics {
  clientName: string;
  isFrozen: boolean;
  isThawing: boolean;
  thawRequestCount: number;
  rateLimit: CreatedRateLimit;
  requestsInQueue: ClientRequestsStatistics;
  requestsInProgress: ClientRequestsStatistics;
}

export interface ClientRequestsStatistics {
  count: number;
  cost: number;
  requests: RequestMetadata[];
}

export interface ClientTokensUpdatedData {
  clientId: string;
  clientName: string;
  tokens: number;
}

export type AuthCreateData =
  | AuthDataOAuth2ClientCredentials
  | AuthDataOAuth2GrantType
  | AuthDataToken
  | AuthDataBasic;

export interface AuthDataOAuth2ClientCredentials
  extends OAuthBaseData,
    CustomHeader {
  type: "oauth2ClientCredentials";
  refreshConfig: OAuthRefreshConfig;
}

export interface AuthDataOAuth2GrantType extends OAuthBaseData, CustomHeader {
  type: "oauth2GrantType";
  refreshToken: string;
  refreshConfig: OAuthRefreshConfig;
}

export interface OAuthRefreshConfig {
  /** Where to send the OAuth request */
  url: string;
  /**
   * Where to put the authentication data in the request:
   *
   * - `jsonBody`: The data will be sent in the body of the request as JSON
   * - `urlQuery`: The data will be sent in the URL as query parameters
   * - `urlEncodedForm`: The data will be sent in the body of the request as a URL encoded form data
   */
  dataLocation: "jsonBody" | "urlQuery" | "urlEncodedForm";
  /**
   * The data to send in the request
   *
   * Some values are available via keywords so you don't have to hardcode them
   * - `{{clientId}}`: The clientId from the authentication data
   * - `{{clientSecret}}`: The clientSecret from the authentication data
   * - `{{refreshToken}}`: The refreshToken from the authentication data
   */
  data: Record<string, string>;
  /**
   * Any custom headers to include in the request
   *
   * NOTE: If using Basic Auth, use the useBasicAuth property instead
   */
  customHeaders?: { [key: string]: string };
  /**
   * Whether or not to send the clientId and clientSecret as a Base64 encoded string in Basic auth header
   */
  useBasicAuth?: boolean;
  /** If the provided URL does not return data in a normal OAuth standard response, use the responseInterceptor to format it into an acceptable format */
  responseInterceptor?: (
    res: AxiosResponse
  ) =>
    | Promise<OAuthResponse | OAuthGrantTypeResponse>
    | OAuthResponse
    | OAuthGrantTypeResponse;
}

export interface AuthDataToken extends CustomHeader {
  type: "token";
  token: string;
  /** Whether or not to encode in Base64 */
  encodeBase64?: boolean;
}

export interface AuthDataBasic extends CustomHeader {
  type: "basic";
  username: string;
  password: string;
}

export interface OAuthBaseData {
  clientId: string;
  clientSecret: string;
  /** Additional metdata for passing additional info */
  metadata?: { [key: string]: any };
}

export interface OAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export interface OAuthGrantTypeResponse extends OAuthResponse {
  refresh_token: string;
}

export interface CustomHeader {
  /** A Custom header to include the token in */
  customHeaderName?: string;
  /** A Custom prefix to use in front of the token. Default to "Bearer" */
  customPrefix?: string;
  /** Whether or not to exclude a prefix. Default to false */
  excludePrefix?: boolean;
}
