import { ClientGenerator, CreateClientData } from "../client/types";
import { RequestConfig } from "../request/types";
import { AxiosResponse } from "axios";
import defaultLogger from "./logger";
import BaseError from "../baseError";
import EventEmitter from "events";
import { Logger } from "winston";
import Client from "../client";
import IORedis from "ioredis";
import start from "./start";
import { v4 } from "uuid";
import {
  RequestHandlerConstructorOptions,
  RequestHandlerMetadata,
  RequestHandlerStatus,
} from "./types";

export default class RequestHandler {
  protected id: string;
  protected priority: number;
  protected status: RequestHandlerStatus;
  protected redis: IORedis;
  protected redisName: string;
  protected redisListener: IORedis;
  protected logger: Logger;
  protected heartbeatTimeouts: Map<string, NodeJS.Timeout> = new Map();
  protected heartbeatInterval?: NodeJS.Timeout;
  protected emitter: NodeJS.EventEmitter = new EventEmitter();
  protected key: string;
  protected clients: Map<string, Client> = new Map();
  protected defaultClient: CreateClientData;
  protected clientGenerators: Record<string, ClientGenerator>;

  public start = start.bind(this);

  /**
   * Constructs a new RequestHandler.
   *
   * The only required option is `redis`, which is the redis client to use for storing tokens.
   *
   * @param data The options to use when creating the request handler
   */

  constructor(data: RequestHandlerConstructorOptions) {
    this.id = v4();
    this.priority = data.priority || 1;
    this.status = "stopped";
    this.redis = data.redis;
    this.redisName = `${
      data.redisKeyPrefix ? `${data.redisKeyPrefix}:` : ""
    }requestHandler`;
    this.redisListener = data.redis.duplicate().setMaxListeners(3);
    this.key = data.key;
    this.clientGenerators = data.clientGenerators || {};
    this.defaultClient = data.defaultClientOptions || {
      rateLimit: { type: "noLimit" },
      name: "default",
    };
    this.logger = data.logger ? data.logger : defaultLogger;
  }

  /**
   * This method stops the request handler instance in a way that allows other instances to take over any clients that were owned by this instance.
   *
   * This method should be called when the instance is being shut down and does the following:
   * - Removes the instance from the list of instances
   * - Deletes the instance from the Redis store
   * - Publishes a message to all instances to update their client lists
   * - Clears the keep alive interval
   *
   */

  public async stop() {
    if (this.status !== "started") return;
    this.status = "stopped";
    const pipeline = this.redis.pipeline();
    pipeline.srem(`${this.redisName}:instances`, this.id);
    pipeline.del(`${this.redisName}:instance:${this.id}`);
    pipeline.publish(`${this.redisName}:instanceStopped`, this.id);
    await pipeline.exec();
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
    this.logger.warn(`Stopped request handler instance with ID ${this.id}`);
  }

  public getMetadata(this: RequestHandler): RequestHandlerMetadata {
    const metadata: RequestHandlerMetadata = {
      id: this.id,
      status: this.status,
      priority: this.priority,
      registeredClients: Array.from(this.clients.keys()),
      ownedClients: [],
    };
    for (const c of this.clients.values()) {
      if (c.getRole() !== "controller") continue;
      metadata.ownedClients.push(c.getName());
    }
    return metadata;
  }

  /**
   * The controller function for handling requests.
   *
   * @param config The Axios request config.
   * @returns The AxiosResponse.
   */

  public async handleRequest(config: RequestConfig): Promise<AxiosResponse> {
    if (this.status !== "started") await this.waitUntilStarted();
    const client = this.getClient(config.clientName);
    return await client.handleRequest(config);
  }

  /**
   * Waits until the RequestHandler is started.
   *
   * @returns A promise that resolves when the RequestHandler is started.
   */

  private waitUntilStarted(this: RequestHandler): Promise<void> {
    return new Promise((resolve) => {
      if (this.status === "started") return resolve();
      this.emitter.once("instanceStarted", () => resolve());
    });
  }

  /**
   * This method sends a message to all instances to regenerate clients. This method is mostly used after a new OAuth client is created.
   *
   * @param generatorNames Optional names of generators to regenerate clients for
   */

  public async regenerateClients(generatorNames?: string[]) {
    await this.redis.publish(
      `${this.redisName}:regenerateClients`,
      JSON.stringify(generatorNames || [])
    );
  }

  /**
   * This method sends a message to all instances to destroy the client with the given name.
   *
   * @param clientName The name of the client to destroy
   */

  public async destroyClient(clientName: string) {
    this.getClient(clientName);
    await this.redis.publish(
      `${this.redisName}:destroyClient`,
      JSON.stringify({ clientName })
    );
  }

  /**
   * Returns the client with the given name if it exists.
   * Otherwise, throws an error.
   *
   * @param clientName The name of the client to get
   */

  protected getClient(clientName: string): Client {
    const client = this.clients.get(clientName);
    if (client) return client;
    throw new BaseError(
      this.logger,
      `Client with name ${clientName} does not exist.`
    );
  }

  /**
   * Returns the statistics for the client with the given name.
   *
   * If the client does not exist, an error is thrown.
   *
   * @param clientName The name of the client to get the statistics for
   * @returns
   */

  public async getClientStats(clientName: string) {
    return this.getClient(clientName).getStats();
  }
}
