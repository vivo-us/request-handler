import createClients from "./createClients";
import startRedis from "./startRedis";
import RequestHandler from "..";
import {
  getNodeData,
  updateClientRoles,
  updateNodeRegistration,
  updateNodesMap,
} from "./helpers";

/**
 * Initializes the request handler by:
 * - Creating the default client
 * - Creating the clients generated by the client generators.
 */
async function initNode(this: RequestHandler) {
  if (this.isInitialized) return;
  await startRedis.bind(this)();
  await createClients.bind(this)();
  await updateNodesMap.bind(this)();
  await updateNodeRegistration.bind(this)(false);
  await this.redis.sadd(`${this.redisName}:nodes`, this.id);
  await updateClientRoles.bind(this)(false);
  await this.redis.publish(
    `${this.redisName}:nodeAdded`,
    JSON.stringify(getNodeData.bind(this)())
  );
  this.isInitialized = true;
  this.emitter.emit("nodeInitialized");
  this.logger.info(`Initialized request handler node with ID ${this.id}`);
}

export default initNode;
