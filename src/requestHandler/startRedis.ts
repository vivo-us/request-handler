import { ClientTokensUpdatedData, RateLimitUpdatedData } from "../client/types";
import { RequestDoneData, RequestMetadata } from "../request/types";
import updateClientRoles from "./updateClientRoles";
import createClients from "./createClients";
import RequestHandler from ".";

/**
 * This method starts the Redis listener and subscribes to the channels that the RequestHandler listens to.
 */

async function startRedis(this: RequestHandler) {
  await this.redisListener.subscribe(
    `${this.redisName}:instanceStarted`,
    `${this.redisName}:instanceUpdated`,
    `${this.redisName}:instanceHeartbeat`,
    `${this.redisName}:instanceStopped`,
    `${this.redisName}:regenerateClients`,
    `${this.redisName}:destroyClient`,
    `${this.redisName}:requestAdded`,
    `${this.redisName}:requestHeartbeat`,
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
    case `${this.redisName}:instanceStarted`:
      await handleInstanceStarted.bind(this)(message);
      break;
    case `${this.redisName}:instanceUpdated`:
      await handleInstanceUpdated.bind(this)(message);
      break;
    case `${this.redisName}:instanceHeartbeat`:
      await handleInstanceHeartbeat.bind(this)(message);
      break;
    case `${this.redisName}:instanceStopped`:
      await handleInstanceStopped.bind(this)(message);
      break;
    case `${this.redisName}:regenerateClients`:
      await handleRegenerateClients.bind(this)(message);
      break;
    case `${this.redisName}:destroyClient`:
      handleDestroyClient.bind(this)(message);
      break;
    case `${this.redisName}:clientTokensUpdated`:
      await handleClientTokensUpdated.bind(this)(message);
      break;
    case `${this.redisName}:requestAdded`:
      handleRequestAdded.bind(this)(message);
      break;
    case `${this.redisName}:requestHeartbeat`:
      handleRequestHeartbeat.bind(this)(message);
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

async function handleInstanceStarted(this: RequestHandler, message: string) {
  if (this.id === message) return;
  this.heartbeatTimeouts.set(
    message,
    setTimeout(async () => {
      this.logger.warn(
        `Instance ${message} has not sent a heartbeat in 3 seconds`
      );
      await handleInstanceStopped.bind(this)(message);
    }, 3000)
  );
  await updateClientRoles.bind(this)();
}

async function handleInstanceUpdated(this: RequestHandler, message: string) {
  if (this.id === message) return;
  await updateClientRoles.bind(this)();
}

async function handleInstanceHeartbeat(this: RequestHandler, message: string) {
  if (this.id === message) return;
  const timeout = this.heartbeatTimeouts.get(message);
  if (timeout) timeout.refresh();
  else await handleInstanceStarted.bind(this)(message);
}

async function handleInstanceStopped(this: RequestHandler, message: string) {
  if (this.id === message) return;
  const timeout = this.heartbeatTimeouts.get(message);
  if (timeout) clearTimeout(timeout);
  this.heartbeatTimeouts.delete(message);
  await updateClientRoles.bind(this)();
}

async function handleRegenerateClients(this: RequestHandler, message: string) {
  await createClients.bind(this)(JSON.parse(message));
  await updateClientRoles.bind(this)();
}

function handleDestroyClient(this: RequestHandler, message: string) {
  const data = JSON.parse(message);
  const destroyClient = this.getClient(data.clientName);
  destroyClient.destroy();
  this.clients.delete(data.clientName);
}

function handleClientTokensUpdated(this: RequestHandler, message: string) {
  const data: ClientTokensUpdatedData = JSON.parse(message);
  const client = this.getClient(data.clientName);
  client.handleTokensUpdated(data);
}

function handleRequestAdded(this: RequestHandler, message: string) {
  const metadata: RequestMetadata = JSON.parse(message);
  const addedClient = this.clients.get(metadata.clientName);
  if (addedClient) addedClient.handleRequestAdded(metadata);
}

function handleRequestHeartbeat(this: RequestHandler, message: string) {
  const heartbeatData: RequestMetadata = JSON.parse(message);
  const heartbeatClient = this.clients.get(heartbeatData.clientName);
  if (heartbeatClient) heartbeatClient.handleRequestHeartbeat(heartbeatData);
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
