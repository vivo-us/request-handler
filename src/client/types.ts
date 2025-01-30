import { AxiosResponse, CreateAxiosDefaults } from "axios";
import { AuthCreateData } from "../authenticator/types";
import { RequestOptions } from "../request/types";
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
  redisListener: IORedis;
  requestHandlerRedisName: string;
  logger: Logger;
  key: string;
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
}
