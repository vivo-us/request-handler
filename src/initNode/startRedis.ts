import { ClientStatistics, RateLimitUpdatedData } from "../client/types";
import { RequestDoneData, RequestMetadata } from "../request/types";
import { ClientStatsRequest, RequestHandlerNode } from "../types";
import { updateClientRoles, updateNodesMap } from "./helpers";
import createClients from "./createClients";
import RequestHandler from "..";
/**
 * This method starts the Redis listener and subscribes to the channels that the RequestHandler listens to.
 */

async function startRedis(this: RequestHandler) {
  await this.redisListener.subscribe(
    `${this.redisName}:nodeAdded`,
    `${this.redisName}:nodeHeartbeat`,
    `${this.redisName}:nodeRemoved`,
    `${this.redisName}:regenerateClients`,
    `${this.redisName}:destroyClient`,
    `${this.redisName}:clientStatsRequested`,
    `${this.redisName}:clientStatsReady:${this.id}`,
    `${this.redisName}:requestAdded`,
    `${this.redisName}:requestReady`,
    `${this.redisName}:requestDone`,
    `${this.redisName}:rateLimitUpdated`
  );
  this.redisListener.on("message", handleRedisMessage.bind(this));
}

/**
 * This method handles messages sent on the Redis channels that the RequestHandler listens to and takes the appropriate action.
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
    case `${this.redisName}:nodeAdded`:
      await handleNodeAdded.bind(this)(message);
      break;
    case `${this.redisName}:nodeUpdated`:
      await handleNodeUpdated.bind(this)(message);
      break;
    case `${this.redisName}:nodeHeartbeat`:
      handleNodeHeartbeat.bind(this)(message);
      break;
    case `${this.redisName}:nodeRemoved`:
      await handleNodeRemoved.bind(this)(message);
      break;
    case `${this.redisName}:regenerateClients`:
      await handleRegenerateClients.bind(this)(message);
      break;
    case `${this.redisName}:destroyClient`:
      handleDestroyClient.bind(this)(message);
      break;
    case `${this.redisName}:clientStatsRequested`:
      await handleClientStatsRequested.bind(this)(message);
      break;
    case `${this.redisName}:clientStatsReady:${this.id}`:
      handleClientStatsReady.bind(this)(message);
      break;
    case `${this.redisName}:requestAdded`:
      handleRequestAdded.bind(this)(message);
      break;
    case `${this.redisName}:requestReady`:
      handleRequestReady.bind(this)(message);
      break;
    case `${this.redisName}:requestDone`:
      handleRequestDone.bind(this)(message);
      break;
    case `${this.redisName}:rateLimitUpdated`:
      handleRateLimitUpdated.bind(this)(message);
      break;
    default:
      return;
  }
}

async function handleNodeAdded(this: RequestHandler, message: string) {
  const nodeData: RequestHandlerNode = JSON.parse(message);
  this.nodes.set(nodeData.id, nodeData);
  await updateClientRoles.bind(this)();
}

async function handleNodeUpdated(this: RequestHandler, message: string) {
  const nodeData: RequestHandlerNode = JSON.parse(message);
  this.nodes.set(nodeData.id, nodeData);
  await updateClientRoles.bind(this)();
}

function handleNodeHeartbeat(this: RequestHandler, message: string) {
  if (this.id === message) return;
  const timeout = this.nodeHeartbeatTimeouts.get(message);
  if (timeout) clearTimeout(timeout);
  this.nodeHeartbeatTimeouts.set(
    message,
    setTimeout(async () => {
      this.logger.warn(`Node ${message} has not sent a heartbeat in 3 seconds`);
      this.nodeHeartbeatTimeouts.delete(message);
      this.nodes.delete(message);
      await updateNodesMap.bind(this)();
      await updateClientRoles.bind(this)();
    }, 3000)
  );
}

async function handleNodeRemoved(this: RequestHandler, message: string) {
  this.nodes.delete(message);
  await updateClientRoles.bind(this)();
}

async function handleRegenerateClients(this: RequestHandler, message: string) {
  await createClients.bind(this)(JSON.parse(message));
  await updateClientRoles.bind(this)();
}

function handleDestroyClient(this: RequestHandler, message: string) {
  const data = JSON.parse(message);
  const destroyClient = this.clients.get(data.clientName);
  if (!destroyClient) return;
  destroyClient.destroy();
  this.clients.delete(data.clientName);
}

async function handleClientStatsRequested(
  this: RequestHandler,
  message: string
) {
  const statsReq: ClientStatsRequest = JSON.parse(message);
  const getStatsClient = this.clients.get(statsReq.clientName);
  if (!getStatsClient || getStatsClient.role === "worker") return;
  const stats = getStatsClient.getStats();
  await this.redis.publish(
    `${this.redisName}:clientStatsReady:${statsReq.nodeId}`,
    JSON.stringify(stats)
  );
}

function handleClientStatsReady(this: RequestHandler, message: string) {
  const statsData: ClientStatistics = JSON.parse(message);
  this.emitter.emit(
    `${this.redisName}:clientStatsReady:${statsData.clientName}`,
    statsData
  );
}

function handleRequestAdded(this: RequestHandler, message: string) {
  const metadata: RequestMetadata = JSON.parse(message);
  const addedClient = this.clients.get(metadata.clientName);
  if (addedClient) addedClient.handleRequestAdded(metadata);
}

function handleRequestReady(this: RequestHandler, message: string) {
  const readyData: RequestMetadata = JSON.parse(message);
  const readyClient = this.clients.get(readyData.clientName);
  if (readyClient) readyClient.handleRequestReady(readyData);
}

function handleRequestDone(this: RequestHandler, message: string) {
  const doneData: RequestDoneData = JSON.parse(message);
  const doneClient = this.clients.get(doneData.clientName);
  if (doneClient) doneClient.handleRequestDone(doneData);
}

async function handleRateLimitUpdated(this: RequestHandler, message: string) {
  const updatedData: RateLimitUpdatedData = JSON.parse(message);
  const client = this.clients.get(updatedData.clientName);
  if (client) client.handleRateLimitUpdated(updatedData);
}

export default startRedis;
