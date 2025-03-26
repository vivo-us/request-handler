import { RequestHandlerNode } from "../types";
import createClients from "./createClients";
import RequestHandler from "..";
import {
  RateLimitUpdatedData,
  RequestDoneData,
  RequestMetadata,
} from "../client/types";

/**
 * Initializes the request handler by:
 * - Creating the default client
 * - Creating the clients generated by the client generators.
 */
async function initNode(this: RequestHandler) {
  if (this.isInitialized) return;
  await createClients.bind(this)();
  await startRedis.bind(this)();
  await registerNode.bind(this)();
  setInterval(
    async () => await getOwnedClients.bind(this)(),
    this.roleCheckIntervalMs
  );
  this.isInitialized = true;
  this.logger.info(`Initialized request handler node with ID ${this.id}`);
}

/**
 * This method starts the Redis listener and subscribes to the channels that the RequestHandler listens to.
 */

async function startRedis(this: RequestHandler) {
  await this.redisListener.subscribe(
    `${this.redisName}:regenerateClients`,
    `${this.redisName}:destroyClient`,
    `${this.redisName}:nodeUpdate`,
    `${this.redisName}:requestAdded`,
    `${this.redisName}:requestReady`,
    `${this.redisName}:requestDone`,
    `${this.redisName}:rateLimitUpdated`
  );
  this.redisListener.on("message", handleRedisMessage.bind(this));
}

/**
 * This method registers the node with the Redis store and starts the keep alive interval.
 *
 * This method then triggers all nodes to update their client lists.
 */

async function registerNode(this: RequestHandler) {
  await this.redis.sadd(`${this.redisName}:nodes`, this.id);
  await updateNodeRegistration.bind(this)();
  this.keepNodeAliveInterval = setInterval(async () => {
    await this.redis.expire(`${this.redisName}:node:${this.id}`, 4);
  }, 2000);
  await this.redis.publish(`${this.redisName}:nodeUpdate`, "");
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

async function handleRedisMessage(
  this: RequestHandler,
  channel: string,
  message: string
) {
  switch (channel) {
    case `${this.redisName}:nodeUpdate`:
      await getOwnedClients.bind(this)();
      break;
    case `${this.redisName}:regenerateClients`:
      await createClients.bind(this)(JSON.parse(message));
      await getOwnedClients.bind(this)();
      break;
    case `${this.redisName}:destroyClient`:
      const data = JSON.parse(message);
      const destroyClient = this.getClientIfExists(data.clientName);
      if (!destroyClient) return;
      await destroyClient.destroy();
      this.registeredClients.delete(data.clientName);
      break;
    case `${this.redisName}:requestAdded`:
      const metadata: RequestMetadata = JSON.parse(message);
      const addedClient = await this.getClientIfExists(metadata.clientName);
      if (!addedClient) return;
      addedClient.handleRequestAdded(message);
      break;
    case `${this.redisName}:requestReady`:
      this.emitter.emit(`requestReady:${message}`, message);
      break;
    case `${this.redisName}:requestDone`:
      const doneData: RequestDoneData = JSON.parse(message);
      const doneClient = await this.getClientIfExists(doneData.clientName);
      if (!doneClient) return;
      doneClient.handleRequestDone(message);
      break;
    case `${this.redisName}:rateLimitUpdated`:
      const updatedData: RateLimitUpdatedData = JSON.parse(message);
      const client = await this.getClientIfExists(updatedData.clientName);
      if (!client) return;
      client.handleRateLimitUpdated(message);
      break;
    default:
      return;
  }
}

/**
 * This method gets the clients owned by the node by comparing the list of registered clients with the list of clients registered before the node.
 *
 * Any clients that were registered before the node are set to "slave" and any clients that were registered on or after the node are set to "master".
 */

async function getOwnedClients(this: RequestHandler) {
  const clientsBefore = await getClientsBeforeNode.bind(this)();
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
  if (hasChanged) await updateNodeRegistration.bind(this)();
}

/**
 * This method gets a list of clients before the node
 */

async function getClientsBeforeNode(this: RequestHandler) {
  const nodes = await getNodes.bind(this)();
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
async function getNodes(this: RequestHandler) {
  const ids = await this.redis.smembers(`${this.redisName}:nodes`);
  const nodeData: RequestHandlerNode[] = [];
  for (const id of ids) {
    const data = await this.redis.get(`${this.redisName}:node:${id}`);
    if (!data) {
      this.logger.warn(`Node with ID ${id} was not found in the Redis store.`);
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

/**
 * This is a centralized function to update the client lists for the node in the Redis store.
 */

async function updateNodeRegistration(this: RequestHandler) {
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

export default initNode;
