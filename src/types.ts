import { ClientGenerator, CreateClientData } from "./client/types";
import { Logger } from "winston";
import IORedis from "ioredis";

export interface RequestHandlerNodeStatus {
  /** The ID of the RequestHandler node (UUID v4)*/
  id: string;
  /** Whether or not the RequestHandler node is initialized */
  initialized: boolean;
  /** The clients owned by the node */
  ownedClients: string[];
}

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
   * Interval at which to check for role changes in ms
   *
   * **Default value: 10000 ms**
   */
  roleCheckInterval?: number;
  /**
   * The priority of the RequestHandler node (higher is better)
   */
  priority?: number;
  /** A custom Winston Logger instance to use for logging */
  logger?: Logger;
}

export interface RequestHandlerNode {
  id: string;
  priority: number;
  registeredClients: string[];
  ownedClients: string[];
}
