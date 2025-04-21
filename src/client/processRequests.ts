import BaseClient from ".";
import { v4 } from "uuid";

/**
 * This method works through the pending requests and processes them in order of priority and timestamp.
 *
 * When a request is at the top of the queue and the client has a token available, the client will remove the request cost and publish the request to the Request's requestReady channel.
 */

async function processRequests(this: BaseClient) {
  if (this.role === "worker") return;
  if (this.processingId || !this.requests.size) return;
  const id = v4();
  this.processingId = id;
  try {
    do {
      if (this.processingId !== id) break;
      const request = getNextRequest.bind(this)();
      if (!request) break;
      await this.waitForTurn(request.cost);
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

function getNextRequest(this: BaseClient) {
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

export default processRequests;
