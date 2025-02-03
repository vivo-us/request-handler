import { ClientGenerator, CreateClientData } from "./client/types";
import { RequestConfig } from "./request/types";
import { AxiosResponse } from "axios";
import defaultLogger from "./logger";
import BaseError from "./baseError";
import { Logger } from "winston";
import Request from "./request";
import Client from "./client";
import IORedis from "ioredis";
import { v4 } from "uuid";
import {
  RequestHandlerNode,
  RequestHandlerConstructorOptions,
  RequestHandlerNodeStatus,
} from "./types";

export default class RequestHandler {
  private id: string;
  private priority: number;
  private isInitialized;
  private redis: IORedis;
  private redisName: string;
  private redisListener: IORedis;
  private logger: Logger;

  private registeredClients: Map<string, Client> = new Map();
  private ownedClients: Map<string, Client> = new Map();
  private defaultClient: CreateClientData;
  private clientGenerators: Record<string, ClientGenerator>;

  private keepNodeAliveInterval?: NodeJS.Timeout;
  private roleCheckIntervalMs: number;

  private key: string;

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
    this.redisListener = data.redis.duplicate().setMaxListeners(0);
    this.key = data.key;
    this.clientGenerators = data.clientGenerators || {};
    this.defaultClient = data.defaultClientOptions || {
      rateLimit: { type: "noLimit" },
      name: "default",
    };
    this.roleCheckIntervalMs = data.roleCheckInterval || 10000;
    this.logger = data.logger ? data.logger : defaultLogger;
  }

  /**
   * Initializes the request handler by:
   * - Creating the default client
   * - Creating the clients generated by the client generators.
   */
  public async initNode() {
    if (this.isInitialized) return;
    await this.createClients();
    await this.startRedis();
    await this.registerNode();
    setInterval(
      async () => await this.getOwnedClients(),
      this.roleCheckIntervalMs
    );
    this.isInitialized = true;
    this.logger.info(`Initialized request handler node with ID ${this.id}`);
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
    await this.redis.srem(`${this.redisName}:nodes`, this.id);
    await this.redis.del(`${this.redisName}:node:${this.id}`);
    await this.redis.publish(`${this.redisName}:nodeUpdate`, "");
    clearInterval(this.keepNodeAliveInterval);
    this.logger.warn(`Destroyed request handler node with ID ${this.id}`);
  }

  /**
   * Returns the status of the request handler. This includes:
   * - id: The ID of the node
   * - ownedClients: The names of the clients owned by the node
   * - initialized: Whether the node has been initialized
   */
  public getNodeStatus(): RequestHandlerNodeStatus {
    return {
      id: this.id,
      ownedClients: Array.from(this.ownedClients.keys()),
      initialized: this.isInitialized,
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
    const request = new Request(client, config, this.logger);
    return await request.send();
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
  private getClient(clientName: string): Client {
    const client = this.getClientIfExists(clientName);
    if (client) return client;
    throw new BaseError(
      this.logger,
      `Client with name ${clientName} does not exist.`
    );
  }

  /**
   * Returns the client with the given name if it exists.
   *
   * @param clientName The name of the client to get
   * @returns
   */

  private getClientIfExists(clientName: string): Client | undefined {
    return this.registeredClients.get(clientName);
  }

  /**
   * This method uses the client generators provided when the RequestHandler was created to create new clients.
   *
   * If the `generatorNames` parameter is provided, only the clients generated by the generators with those names will be created.
   *
   * If the client already exists, the old one is reset so that the new one can take over.
   *
   * The clients are then generated and assigned their roles.
   *
   * @param generatorNames Optionally the names of the generators to regenerate clients for
   */

  private async createClients(generatorNames: string[] = []) {
    const clientsToGenerate: CreateClientData[] = [this.defaultClient];
    for (const each in this.clientGenerators) {
      if (generatorNames.length && !generatorNames.includes(each)) continue;
      const clients = await this.clientGenerators[each]();
      clientsToGenerate.push(...clients);
    }
    await this.generateClients(clientsToGenerate);
  }

  /**
   * This method generates the clients provided in the `clients` parameter and if a parent client is provided, merges the parent and child clients data so that the child client inherits the parent's data.
   *
   * @param clients The client data to generate clients for
   * @param parent The parent of a client if it exists. This is used to merge the parent and child clients data
   */

  private async generateClients(
    clients: CreateClientData[],
    parent?: CreateClientData
  ) {
    for (let client of clients) {
      if (client.sharedRateLimitClientName) {
        const sharedClient = this.getClient(client.sharedRateLimitClientName);
        client.rateLimit = sharedClient.rateLimit;
      }
      if (parent) client = this.mergeChildParentClients(client, parent);
      await this.resetClient(client.name);
      await this.createClient(client);
      if (client.subClients) {
        await this.generateClients(client.subClients, client);
      }
    }
  }

  /**
   *  This method merges the data of the child client with the parent client. Child client data takes precedence over parent client data.
   *
   * @param child The child client data
   * @param parent The parent client data
   * @returns
   */

  private mergeChildParentClients(
    child: CreateClientData,
    parent: CreateClientData
  ): CreateClientData {
    let parentClone = { ...parent };
    delete parentClone.subClients;
    const merged: CreateClientData = {
      ...parentClone,
      ...child,
      name: `${parent.name}:${child.name}`,
      metadata: {
        ...parent.metadata,
        ...child.metadata,
      },
      axiosOptions: {
        ...parent.axiosOptions,
        ...child.axiosOptions,
      },
      requestOptions: {
        ...parent.requestOptions,
        ...child.requestOptions,
        defaults: {
          ...parent.requestOptions?.defaults,
          ...child.requestOptions?.defaults,
        },
        retryOptions: {
          ...parent.requestOptions?.retryOptions,
          ...child.requestOptions?.retryOptions,
        },
      },
    };
    return merged;
  }

  /**
   * This method resets the client with the given name so that a new client can take over.
   */

  private async resetClient(clientName: string) {
    const client = this.getClientIfExists(clientName);
    if (!client) return;
    await client.updateRole("slave");
    this.ownedClients.delete(clientName);
    this.registeredClients.delete(clientName);
  }

  /**
   * Creates a new client with the given data.
   *
   * If a client with the given name already exists, throws an error.
   *
   * @param data The data to use to create the client
   */
  private async createClient(data: CreateClientData) {
    const existing = this.getClientIfExists(data.name);
    if (existing) {
      throw new BaseError(
        this.logger,
        `Client with name ${data.name} already exists.`
      );
    }
    const client = new Client({
      client: data,
      redis: this.redis,
      redisListener: this.redisListener,
      requestHandlerRedisName: this.redisName,
      logger: this.logger,
      key: this.key,
    });
    this.registeredClients.set(data.name, client);
    await client.init();
  }

  /**
   * This method starts the Redis listener and subscribes to the channels that the RequestHandler listens to.
   */

  private async startRedis() {
    await this.redisListener.subscribe(`${this.redisName}:regenerateClients`);
    await this.redisListener.subscribe(`${this.redisName}:destroyClient`);
    await this.redisListener.subscribe(`${this.redisName}:nodeUpdate`);
    this.redisListener.on("message", this.handleRedisMessage.bind(this));
  }

  /**
   * This method registers the node with the Redis store and starts the keep alive interval.
   *
   * This method then triggers all nodes to update their client lists.
   */

  private async registerNode() {
    await this.redis.sadd(`${this.redisName}:nodes`, this.id);
    await this.updateNodeRegistration();
    this.keepNodeAliveInterval = setInterval(async () => {
      await this.redis.expire(`${this.redisName}:node:${this.id}`, 4);
    }, 2000);
    await this.redis.publish(`${this.redisName}:nodeUpdate`, "");
  }

  /**
   * This is a centralized function to update the client lists for the node in the Redis store.
   */

  private async updateNodeRegistration() {
    const pipeline = this.redis.pipeline();
    pipeline.set(
      `${this.redisName}:node:${this.id}`,
      JSON.stringify({
        id: this.id,
        priority: this.priority,
        registeredClients: Array.from(this.registeredClients.keys()),
        ownedClients: Array.from(this.ownedClients.keys()),
      })
    );
    pipeline.expire(`${this.redisName}:node:${this.id}`, 4);
    await pipeline.exec();
  }

  /**
   * Waits until the RequestHandler is initialized.
   *
   * @returns A promise that resolves when the RequestHandler is initialized.
   */
  private waitUntilInitialized(this: RequestHandler): Promise<void> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.isInitialized) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * This method handles messages sent on the Redis channels that the RequestHandler listens to and takes the appropriate action.
   *
   * If the message is a `nodeUpdate` message, the RequestHandler gets the clients owned by the node.
   *
   * If the message is a `regenerateClients` message, the RequestHandler creates the clients provided in the message.
   *
   * If the message is a `destroyClient` message, the RequestHandler destroys the client with the name provided in the message.
   *
   * @param channel The name of the redis channel the message was sent on
   * @param message The message sent on the channel
   * @returns
   */

  private async handleRedisMessage(channel: string, message: string) {
    if (channel === `${this.redisName}:nodeUpdate`) {
      await this.getOwnedClients();
    } else if (channel === `${this.redisName}:regenerateClients`) {
      await this.createClients(JSON.parse(message));
      await this.getOwnedClients();
    } else if (channel === `${this.redisName}:destroyClient`) {
      const data = JSON.parse(message);
      const client = this.getClientIfExists(data.clientName);
      if (!client) return;
      await client.destroy();
      this.registeredClients.delete(data.clientName);
    } else return;
  }

  /**
   * This method gets the clients owned by the node by comparing the list of registered clients with the list of clients registered before the node.
   *
   * Any clients that were registered before the node are set to "slave" and any clients that were registered on or after the node are set to "master".
   */

  private async getOwnedClients() {
    const clientsBefore = await this.getClientsBeforeNode();
    let hasChanged = false;
    for (const [name, client] of this.ownedClients) {
      if (!clientsBefore.includes(name)) continue;
      await client.updateRole("slave");
      this.ownedClients.delete(name);
      hasChanged = true;
    }
    for (const [name, client] of this.registeredClients) {
      if (clientsBefore.includes(name) || this.ownedClients.has(name)) continue;
      await client.updateRole("master");
      this.ownedClients.set(name, client);
      hasChanged = true;
    }
    if (hasChanged) await this.updateNodeRegistration();
  }

  /**
   * This method gets a list of clients before the node
   */

  private async getClientsBeforeNode() {
    const nodes = await this.getNodes();
    const clientsBefore: string[] = [];
    for (const node of nodes) {
      if (node.id === this.id) break;
      for (const client of node.registeredClients) {
        if (!clientsBefore.includes(client)) clientsBefore.push(client);
      }
    }
    return clientsBefore;
  }

  /**
   * This method gets the nodes from the Redis store and sorts them by priority and ID.
   *
   * If a node is not found in the Redis store, it is removed from the list of nodes so that others can take over the clients.
   *
   * @returns A list of nodes sorted by priority and ID
   */
  private async getNodes() {
    const ids = await this.redis.smembers(`${this.redisName}:nodes`);
    const nodeData: RequestHandlerNode[] = [];
    for (const id of ids) {
      const data = await this.redis.get(`${this.redisName}:node:${id}`);
      if (!data) {
        this.logger.warn(
          `Node with ID ${id} was not found in the Redis store.`
        );
        await this.redis.srem(`${this.redisName}:nodes`, id);
        continue;
      }
      nodeData.push(JSON.parse(data));
    }
    const sorted = nodeData.sort((a, b) => {
      if (a.priority > b.priority) return -1;
      else if (a.priority < b.priority) return 1;
      else return b.id.localeCompare(a.id);
    });
    return sorted;
  }
}
