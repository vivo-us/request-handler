import { ClientRole } from "./types";
import Client from ".";

/**
 * This method updates the role of the client.
 *
 * If the roles are the same, the method will return immediately.
 *
 * It will then clear the interval for adding tokens and update the role in the API Health Monitor.
 *
 * If the role is master and the rate limit is not noLimit, the method will add an interval and check for existing requests.
 */

async function updateRole(this: Client, role: ClientRole) {
  if (role === this.role) return;
  this.role = role;
  if (this.interval) clearInterval(this.interval);
  if (this.rateLimit.type === "noLimit") return;
  if (this.createData.sharedRateLimitClientName) return;
  if (this.role === "slave") {
    await this.redisListener.unsubscribe(
      `${this.redisName}:freezeRequests`,
      `${this.redisName}:requestAdded`,
      ...(this.rateLimit.type === "concurrencyLimit"
        ? [`${this.redisName}:requestDone`]
        : [])
    );
    return;
  }
  await this.redisListener.subscribe(
    `${this.redisName}:freezeRequests`,
    `${this.redisName}:requestAdded`,
    ...(this.rateLimit.type === "concurrencyLimit"
      ? [`${this.redisName}:requestDone`]
      : [])
  );
  this.addInterval();
  await checkExistingRequests.bind(this)();
}

/**
 * This method checks for existing requests in the Redis queue and processes them.
 *
 * This is to catch any requests that were added while the client was a slave and were not processed by a previous master.
 */

async function checkExistingRequests(this: Client) {
  const requests = await this.redis.smembers(`${this.redisName}:queue`);
  for (const each of requests) {
    const request = await this.redis.hgetall(`${this.redisName}:queue:${each}`);
    if (!request.priority) {
      await this.redis.srem(`${this.redisName}:queue`, each);
    } else {
      this.pendingRequests.set(each, {
        priority: Number(request.priority),
        timestamp: Number(request.timestamp),
        cost: Number(request.cost),
        retries: 0,
        clientId: this.id,
        requestId: each,
      });
      this.hasUnsortedRequests = true;
    }
  }
  this.emitter.emit("processRequests");
}

export default updateRole;
