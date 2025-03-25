import { RequestDoneData, RequestMetadata } from "./types";
import Client from ".";

/**
 * Handles messages from Redis.
 *
 * If a message is received on the freezeRequests channel and it is the master node, the client will set a freeze end time, clear its tokens, and wait for the specified amount of time before it clears the freeze.
 *
 * If a message is received on the rateLimitUpdated channel, the client will update its rate limit and reset the interval for adding tokens to the client's bucket.
 *
 * If a message is received on the requestAdded channel, the client will add the request to the pendingRequests map and process the requests.
 *
 * @param channel The channel the message was sent on
 * @param message The message sent
 */

async function handleRedisMessage(
  this: Client,
  channel: string,
  message: string
) {
  switch (channel) {
    case `${this.redisName}:requestAdded`:
      handleRequestAdded.bind(this)(message);
      break;
    case `${this.redisName}:${this.id}:requestReady`:
      this.emitter.emit(`requestReady:${message}`, message);
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

function handleRateLimitUpdated(this: Client, message: string) {
  const data = JSON.parse(message);
  this.rateLimit = data;
  this.createData = { ...this.createData, rateLimit: data };
  if (this.role === "slave") return;
  if (this.interval) clearInterval(this.interval);
  this.addInterval();
}

function handleRequestAdded(this: Client, message: string) {
  if (this.role === "slave") return;
  const request: RequestMetadata = JSON.parse(message);
  this.pendingRequests.set(request.requestId, request);
  this.hasUnsortedRequests = true;
  this.emitter.emit("processRequests");
}

function handleRequestDone(this: Client, message: string) {
  if (this.role === "slave") return;
  const data: RequestDoneData = JSON.parse(message);
  if (data.waitTime) handleFreezeRequests.bind(this)(data);
  if (this.rateLimit.type === "concurrencyLimit") this.addTokens(data.cost);
  if (data.requestId !== this.thawRequestId) return;
  if (data.status === "success") this.thawRequestCount--;
  this.thawRequestId = undefined;
}

function handleFreezeRequests(this: Client, data: RequestDoneData) {
  this.logger.debug(`Freezing requests for ${data.waitTime}ms...`);
  if (this.rateLimit.type === "requestLimit") this.tokens = 0;
  if (this.freezeTimeout) clearTimeout(this.freezeTimeout);
  if (data.isRateLimited) {
    this.thawRequestCount =
      this.requestOptions.retryOptions?.thawRequestCount || 3;
  }
  this.freezeTimeout = setTimeout(() => {
    this.freezeTimeout = undefined;
    this.emitter.emit("processRequests");
  }, data.waitTime);
}

export default handleRedisMessage;
