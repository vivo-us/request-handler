import { RequestConfig } from "./request/types";
import { AxiosResponse } from "axios";
import defaultLogger from "./logger";
import BaseError from "./baseError";
import initNode from "./initNode";
import EventEmitter from "events";
import { Logger } from "winston";
import Client from "./client";
import IORedis from "ioredis";
import { v4 } from "uuid";
import {
  ClientStatsRequest,
  RequestHandlerConstructorOptions,
  RequestHandlerMetadata,
} from "./types";
import {
  ClientGenerator,
  ClientStatistics,
  CreateClientData,
} from "./client/types";

export default class RequestHandler {
  protected id: string;
  protected priority: number;
  protected isInitialized;
  protected redis: IORedis;
  protected redisName: string;
  protected redisListener: IORedis;
  protected logger: Logger;
  protected requestHandlers: Map<string, RequestHandlerMetadata> = new Map();
  protected nodeHeartbeatTimeouts: Map<string, NodeJS.Timeout> = new Map();
  protected nodeHeartbeatInterval?: NodeJS.Timeout;
  protected emitter: NodeJS.EventEmitter = new EventEmitter();
  protected key: string;
  protected clients: Map<string, Client> = new Map();
  protected defaultClient: CreateClientData;
  protected clientGenerators: Record<string, ClientGenerator>;

  public initNode = initNode.bind(this);

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
    this.isInitialized = false;
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
   * This method destroys the request handler node in a way that allows other nodes to take over any clients that were owned by this node.
   *
   * This method should be called when the node is being shut down and does the following:
   * - Removes the node from the list of nodes
   * - Deletes the node from the Redis store
   * - Publishes a message to all nodes to update their client lists
   * - Clears the keep alive interval
   *
   */

  public async destroyNode() {
    if (!this.isInitialized) return;
    const pipeline = this.redis.pipeline();
    pipeline.srem(`${this.redisName}:nodes`, this.id);
    pipeline.del(`${this.redisName}:node:${this.id}`);
    pipeline.publish(`${this.redisName}:nodeRemoved`, this.id);
    await pipeline.exec();
    clearInterval(this.nodeHeartbeatInterval);
    this.nodeHeartbeatInterval = undefined;
    this.logger.warn(`Destroyed request handler node with ID ${this.id}`);
  }

  public getMetadata(this: RequestHandler): RequestHandlerMetadata {
    const ownedClients: string[] = [];
    this.clients.forEach((client) => {
      if (client.role === "controller") ownedClients.push(client.name);
    });
    return {
      id: this.id,
      isInitialized: this.isInitialized,
      priority: this.priority,
      registeredClients: Array.from(this.clients.keys()),
      ownedClients,
    };
  }

  /**
   * The controller function for handling requests.
   *
   * @param config The Axios request config.
   * @returns The AxiosResponse.
   */

  public async handleRequest(config: RequestConfig): Promise<AxiosResponse> {
    if (!this.isInitialized) await this.waitUntilInitialized();
    const client = this.getClient(config.clientName);
    return await client.handleRequest(config);
  }

  /**
   * Waits until the RequestHandler is initialized.
   *
   * @returns A promise that resolves when the RequestHandler is initialized.
   */

  private waitUntilInitialized(this: RequestHandler): Promise<void> {
    return new Promise((resolve) => {
      if (this.isInitialized) return resolve();
      this.emitter.once("nodeInitialized", () => resolve());
    });
  }

  /**
   * This method sends a message to all nodes to regenerate clients. This method is mostly used after a new OAuth client is created.
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
   * This method sends a message to all nodes to destroy the client with the given name.
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
    return await this.fetchClientStats(clientName);
  }

  private fetchClientStats(clientName: string): Promise<ClientStatistics> {
    return new Promise(async (resolve) => {
      this.emitter.once(
        `${this.redisName}:clientStatsReady:${clientName}`,
        (data: ClientStatistics) => resolve(data)
      );
      const statsRequest: ClientStatsRequest = {
        clientName,
        nodeId: this.id,
      };
      await this.redis.publish(
        `${this.redisName}:clientStatsRequested`,
        JSON.stringify(statsRequest)
      );
    });
  }
}
