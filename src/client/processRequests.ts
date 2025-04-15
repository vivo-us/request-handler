import { v4 } from "uuid";
import Client from ".";

/**
 * This method works through the pending requests and processes them in order of priority and timestamp.
 *
 * When a request is at the top of the queue and the client has a token available, the client will remove the request cost and publish the request to the Request's requestReady channel.
 */

async function processRequests(this: Client) {
  if (this.processingId || this.role === "worker" || !this.requests.size) {
    return;
  }
  const id = v4();
  this.processingId = id;
  try {
    do {
      if (this.processingId !== id) break;
      const request = getNextRequest.bind(this)();
      if (!request) break;
      await waitForTokens.bind(this)(request.cost);
      if (this.freezeTimeout || this.thawRequestId) break;
      this.tokens -= request.cost;
      if (this.thawRequestCount) this.thawRequestId = request.requestId;
      await this.redis.publish(
        `${this.requestHandlerRedisName}:requestReady`,
        JSON.stringify(request)
      );
      if (this.thawRequestCount) break;
    } while (this.requests.size > 0);
    this.processingId = undefined;
  } catch (e) {
    this.processingId = undefined;
    throw e;
  }
}

function getNextRequest(this: Client) {
  if (this.hasUnsortedRequests) {
    this.requests = new Map(
      [...this.requests].sort(([aKey, aValue], [bKey, bValue]) => {
        if (aValue.status === "inProgress") return 1;
        if (bValue.status === "inProgress") return -1;
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
  for (const each of this.requests.values()) {
    if (each.status === "inQueue") return each;
  }
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
