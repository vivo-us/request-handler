import { RequestHandlerMetadata } from "../types";
import RequestHandler from "..";

/**
 * This method gets the clients owned by the node by comparing the list of registered clients with the list of clients registered before the node.
 *
 * Any clients that were registered before the node are set to "worker" and any clients that were registered on or after the node are set to "controller".
 */

async function updateClientRoles(this: RequestHandler) {
  const clientsBefore = await getClientsBeforeNode.bind(this)();
  let hasChanges = false;
  for (const [name, client] of this.clients) {
    const newRole = clientsBefore.has(name) ? "worker" : "controller";
    if (client.role === newRole) continue;
    client.updateRole(newRole);
    hasChanges = true;
  }
  if (!hasChanges && this.isInitialized) return;
  await updateNodeRegistration.bind(this)(hasChanges);
}

/**
 * This method gets a list of clients before the node
 */

async function getClientsBeforeNode(this: RequestHandler) {
  const nodes = await getNodes.bind(this)();
  const sorted = nodes.sort((a, b) => {
    if (a.priority > b.priority) return -1;
    else if (a.priority < b.priority) return 1;
    else return b.id.localeCompare(a.id);
  });
  const clientsBefore: Set<string> = new Set();
  for (const node of sorted) {
    if (node.id === this.id) break;
    node.registeredClients.forEach((c) => clientsBefore.add(c));
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
  const nodes: RequestHandlerMetadata[] = [this.getMetadata()];
  for (const id of ids) {
    if (id === this.id) continue;
    const data = await this.redis.get(`${this.redisName}:node:${id}`);
    if (!data) {
      this.logger.warn(`Node with ID ${id} was not found in the Redis store.`);
      await this.redis.srem(`${this.redisName}:nodes`, id);
      continue;
    }
    nodes.push(JSON.parse(data));
  }
  return nodes;
}

/**
 * This is a centralized function to update the client lists for the node in the Redis store.
 */

async function updateNodeRegistration(
  this: RequestHandler,
  hasChanges: boolean
) {
  const key = `${this.redisName}:node:${this.id}`;
  const pipeline = this.redis.pipeline();
  pipeline.set(key, JSON.stringify(this.getMetadata()));
  pipeline.expire(key, 3);
  if (!this.isInitialized) {
    pipeline.sadd(`${this.redisName}:nodes`, this.id);
    pipeline.publish(`${this.redisName}:nodeAdded`, this.id);
  }
  if (hasChanges && this.isInitialized) {
    pipeline.publish(`${this.redisName}:nodeUpdated`, this.id);
  }
  await pipeline.exec();
  if (this.nodeHeartbeatInterval) return;
  this.nodeHeartbeatInterval = setInterval(async () => {
    const pipeline = this.redis.pipeline();
    pipeline.expire(key, 3);
    pipeline.publish(`${this.redisName}:nodeHeartbeat`, this.id);
    await pipeline.exec();
  }, 1000);
}

export default updateClientRoles;
