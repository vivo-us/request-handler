import { ClientGenerator, CreateClientData } from "../client/types";
import { Logger } from "winston";
import IORedis from "ioredis";

export type RequestHandlerStatus = "stopped" | "starting" | "started";

export interface RequestHandlerConstructorOptions {
  /** The key to use when encrypting sensitive information */
  key: string;
  /** The Redis client to use */
  redis: IORedis;
  /** A prefix to use for all redis keys */
  redisKeyPrefix?: string;
  /**
   * An array of client generators to use to generate clients.
   */
  clientGenerators?: Record<string, ClientGenerator>;
  /*
   * Options to configure the default client.
   *
   * **Defaults to a `noLimit` client with no other options**
   */
  defaultClientOptions?: CreateClientData;
  /**
   * The priority of the RequestHandler instance (higher is better)
   */
  priority?: number;
  /** A custom Winston Logger instance to use for logging */
  logger?: Logger;
}

export interface RequestHandlerMetadata {
  id: string;
  status: RequestHandlerStatus;
  priority: number;
  registeredClients: string[];
  ownedClients: string[];
}
