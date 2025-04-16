import { v4 } from "uuid";
import Client from ".";

/**
 * This method works through the pending requests and processes them in order of priority and timestamp.
 *
 * When a request is at the top of the queue and the client has a token available, the client will remove the request cost and publish the request to the Request's requestReady channel.
 */

async function processRequests(this: Client) {
  if (this.role === "worker" || this.rateLimit.type === "shared") return;
  if (this.processingId || !this.requests.size) return;
  const id = v4();
  this.processingId = id;
  try {
    do {
      if (this.processingId !== id) break;
      const request = getNextRequest.bind(this)();
      if (!request) break;
      await waitForTurn.bind(this)(request.cost);
      if (this.freezeTimeout || this.thawRequestId) break;
      if (this.thawRequestCount) this.thawRequestId = request.requestId;
      this.requests.set(request.requestId, {
        ...request,
        status: "inProgress",
      });
      await this.redis.publish(
        `${this.requestHandlerRedisName}:requestReady`,
        JSON.stringify({ ...request, status: "inProgress" })
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

async function waitForTurn(this: Client, cost: number): Promise<boolean> {
  switch (this.rateLimit.type) {
    case "requestLimit":
      return await waitForTokens.bind(this)(cost);
    case "concurrencyLimit":
      return waitForConcurrency.bind(this)(cost);
    default:
      return Promise.resolve(true);
  }
}

/**
 * This method checks for enough tokens in the client's bucket.
 *
 * If the client has enough tokens, the method will resolve immediately.
 *
 * If the client does not have enough tokens, the method will wait for enough tokens to be added to the client's bucket.
 */

async function waitForTokens(this: Client, cost: number): Promise<boolean> {
  if (this.rateLimit.type !== "requestLimit") return Promise.resolve(true);
  if (this.rateLimit.tokens >= cost) {
    this.rateLimit.tokens -= cost;
    await this.redis.publish(
      `${this.requestHandlerRedisName}:clientTokensUpdated`,
      JSON.stringify({ clientName: this.name, tokens: this.rateLimit.tokens })
    );
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const listener = async () => {
      if (this.rateLimit.type !== "requestLimit") return;
      if (this.rateLimit.tokens < cost) return;
      this.emitter.off(`${this.redisName}:tokensAdded`, listener);
      this.rateLimit.tokens -= cost;
      await this.redis.publish(
        `${this.requestHandlerRedisName}:clientTokensUpdated`,
        JSON.stringify({ clientName: this.name, tokens: this.rateLimit.tokens })
      );
      resolve(true);
    };
    this.emitter.on(`${this.redisName}:tokensAdded`, listener);
  });
}

function waitForConcurrency(this: Client, cost: number): Promise<boolean> {
  if (this.rateLimit.type !== "concurrencyLimit") return Promise.resolve(true);
  const { maxConcurrency } = this.rateLimit;
  const currCost = getRequestsInProgressCost.bind(this)();
  if (maxConcurrency >= currCost + cost) return Promise.resolve(true);
  return new Promise((resolve) => {
    const listener = () => {
      const currCost = getRequestsInProgressCost.bind(this)();
      if (maxConcurrency < currCost + cost) return;
      resolve(true);
      this.emitter.off(`${this.redisName}:requestDone`, listener);
    };
    this.emitter.on(`${this.redisName}:requestDone`, listener);
  });
}

function getRequestsInProgressCost(this: Client) {
  let cost = 0;
  for (const request of this.requests.values()) {
    if (request.status !== "inProgress") continue;
    cost += request.cost;
  }
  return cost;
}

export default processRequests;
