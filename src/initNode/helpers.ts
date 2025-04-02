import RequestHandler from "..";

/**
 * This method gets the clients owned by the node by comparing the list of registered clients with the list of clients registered before the node.
 *
 * Any clients that were registered before the node are set to "worker" and any clients that were registered on or after the node are set to "controller".
 */

export async function updateClientRoles(
  this: RequestHandler,
  shouldUpdateRegistration = true
) {
  const clientsBefore = getClientsBeforeNode.bind(this)();
  let hasChanges = false;
  for (const [name, client] of this.clients) {
    const newRole = clientsBefore.has(name) ? "worker" : "controller";
    if (client.role === newRole) continue;
    client.updateRole(newRole);
    hasChanges = true;
  }
  if (!hasChanges || !shouldUpdateRegistration) return;
  await updateNodeRegistration.bind(this)(hasChanges);
}

/**
 * This method gets a list of clients before the node
 */

function getClientsBeforeNode(this: RequestHandler) {
  const nodes = Array.from(this.requestHandlers.values());
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
 * This is a centralized function to update the client lists for the node in the Redis store.
 */

export async function updateNodeRegistration(
  this: RequestHandler,
  hasChanges: boolean
) {
  const nodeData = this.getMetadata();
  this.requestHandlers.set(this.id, nodeData);
  const pipeline = this.redis.pipeline();
  pipeline.set(`${this.redisName}:node:${this.id}`, JSON.stringify(nodeData));
  pipeline.expire(`${this.redisName}:node:${this.id}`, 3);
  if (hasChanges) {
    pipeline.publish(`${this.redisName}:nodeUpdated`, JSON.stringify(nodeData));
  }
  await pipeline.exec();
  if (this.nodeHeartbeatInterval) clearInterval(this.nodeHeartbeatInterval);
  this.nodeHeartbeatInterval = setInterval(async () => {
    const pipeline = this.redis.pipeline();
    pipeline.expire(`${this.redisName}:node:${this.id}`, 3);
    pipeline.publish(`${this.redisName}:nodeHeartbeat`, this.id);
    await pipeline.exec();
  }, 1000);
}

/**
 * This method gets the nodes from the Redis store and sorts them by priority and ID.
 *
 * If a node is not found in the Redis store, it is removed from the list of nodes so that others can take over the clients.
 *
 * @returns A list of nodes sorted by priority and ID
 */

export async function updateNodesMap(this: RequestHandler) {
  const ids = await this.redis.smembers(`${this.redisName}:nodes`);
  for (const id of ids) {
    const data = await this.redis.get(`${this.redisName}:node:${id}`);
    if (!data) {
      this.logger.warn(`Node with ID ${id} was not found in the Redis store.`);
      await this.redis.srem(`${this.redisName}:nodes`, id);
      continue;
    }
    this.requestHandlers.set(id, JSON.parse(data));
  }
}
