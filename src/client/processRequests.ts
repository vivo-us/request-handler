import { v4 } from "uuid";
import Client from ".";

/**
 * This method works through the pending requests and processes them in order of priority and timestamp.
 *
 * When a request is at the top of the queue and the client has a token available, the client will remove the request cost and publish the request to the Request's requestReady channel.
 */

async function processRequests(this: Client) {
  if (this.processingId || this.role === "slave") return;
  const id = v4();
  this.processingId = id;
  try {
    do {
      if (this.processingId !== id) break;
      const next = getNextRequest.bind(this)();
      if (!next) break;
      const [key, request] = next;
      await waitForTokens.bind(this)(request.cost);
      if (this.freezeTimeout || this.thawRequestId) break;
      this.tokens -= request.cost;
      this.requestsInProgress.set(key, request);
      this.requestsInQueue.delete(key);
      if (this.thawRequestCount) this.thawRequestId = key;
      await this.redis.publish(
        `${this.requestHandlerRedisName}:requestReady`,
        key
      );
      if (this.thawRequestCount) break;
    } while (this.requestsInQueue.size > 0);
    this.processingId = undefined;
  } catch (e) {
    this.processingId = undefined;
    throw e;
  }
}

function getNextRequest(this: Client) {
  if (this.hasUnsortedRequests) {
    this.requestsInQueue = new Map(
      [...this.requestsInQueue].sort(([aKey, aValue], [bKey, bValue]) => {
        if (aValue.priority === bValue.priority) {
          if (aValue.retries === bValue.retries) {
            if (aValue.timestamp === bValue.timestamp) {
              return aValue.requestId < bValue.requestId ? -1 : 1;
            } else return aValue.timestamp - bValue.timestamp;
          } else return bValue.retries - aValue.retries;
        } else return bValue.priority - aValue.priority;
      })
    );
    this.hasUnsortedRequests = false;
  }
  return this.requestsInQueue.entries().next().value;
}

/**
 * This method checks for enough tokens in the client's bucket.
 *
 * If the client has enough tokens, the method will resolve immediately.
 *
 * If the client does not have enough tokens, the method will wait for enough tokens to be added to the client's bucket.
 */

function waitForTokens(this: Client, cost: number): Promise<boolean> {
  if (this.tokens >= cost) return Promise.resolve(true);
  return new Promise((resolve) => {
    const listener = () => {
      if (this.tokens < cost) return;
      resolve(true);
      this.emitter.off(`${this.redisName}:tokensAdded`, listener);
    };
    this.emitter.on(`${this.redisName}:tokensAdded`, listener);
  });
}

export default processRequests;
