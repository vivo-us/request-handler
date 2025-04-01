import { RequestMetadata } from "../request/types";
import { ClientRole } from "./types";
import Client from ".";

/**
 * This method ensures that all proper actions are taken based on the role of the client.
 *
 * Always clears the addTokensInterval and healthCheckInterval if they are running.
 *
 * If the client is a worker, no further action is taken.
 *
 * If the client has the controller role, it will take the following actions:
 * - Start the addTokensInterval
 * - Start the health check interval
 * - Check for existing requests in the Redis queue
 * - Emit the processRequests event
 *
 *
 */

async function updateRole(this: Client, role: ClientRole) {
  if (role === this.role) return;
  this.role = role;
  this.removeAddTokensInterval();
  this.removeHealthCheckInterval();
  if (this.rateLimit.type === "noLimit" || this.role === "worker") return;
  if (this.createData.sharedRateLimitClientName) return;
  this.startAddTokensInterval();
  startHealthCheckInterval.bind(this)();
  await checkExistingRequests.bind(this)();
  this.emitter.emit(`${this.redisName}:processRequests`);
}

/**
 * This method starts the health check interval for the client.
 *
 * If there is already an interval running, it will be cleared.
 *
 * If the client is a worker, no further action is taken.
 *
 * If the client is a controller, the method will start an interval that runs every 60 seconds by default.
 *
 */

function startHealthCheckInterval(this: Client) {
  this.removeHealthCheckInterval();
  if (this.role === "worker") return;
  this.healthCheckInterval = setInterval(
    async () => await healthCheck.bind(this)(),
    this.createData.healthCheckIntervalMs || 60000
  );
}

/**
 * Ensures that the client is acting properly for its given role and rate limit type
 *
 * If the client is a worker, no action is taken.
 *
 * If the client is a noLimit client, no action is taken.
 *
 * If the client is a requestLimit client, the addTokensInterval is started if it is not already running.
 *
 * If the client is a concurrencyLimit client, it checks the requests in progress and adds tokens if there are any behind.
 *
 * @param this The client instance
 * @returns
 */

async function healthCheck(this: Client) {
  if (this.role === "worker") return;
  if (this.rateLimit.type === "noLimit") return;
  await getRequests.bind(this)(`queue`, this.requestsInQueue);
  const inProgress = await getRequests.bind(this)(
    `inProgress`,
    this.requestsInProgress
  );
  if (this.rateLimit.type === "requestLimit" && !this.addTokensInterval) {
    this.logger.warn(
      `Starting missing addTokensInterval for client ${this.name}`
    );
    this.startAddTokensInterval();
    return;
  }
  if (this.rateLimit.type === "concurrencyLimit") {
    const tokensBehind = this.maxTokens - this.tokens - inProgress.length;
    if (tokensBehind > 0) await this.addTokens(tokensBehind);
  }
}

/**
 * Checks the requests in a given namespace to ensure they are still active. If not, it removes them from the Redis set and the provided map.
 *
 * A request stays active by the client continuing to reset the expriration time on the request until it is completed.
 *
 * A request may go inactive if the client crashes or is stopped before the client returns the request.
 *
 * @param this The client instance
 * @param namespace The redis namespace to check
 * @param map The requests map to check
 * @returns
 */

async function getRequests(
  this: Client,
  namespace: string,
  map: Map<string, RequestMetadata>
) {
  const requests = await this.redis.smembers(`${this.redisName}:${namespace}`);
  if (!requests.length) return [];
  const pipeline = this.redis.pipeline();
  requests.forEach((r) => pipeline.get(`${this.redisName}:${namespace}:${r}`));
  const keys = await pipeline.exec();
  const indexesToRemove: number[] = [];
  keys?.forEach(([err, res], i) => {
    if (!res) indexesToRemove.push(i);
  });
  if (!indexesToRemove.length) return requests;
  const validRequests: string[] = [];
  const remPipeline = this.redis.pipeline();
  requests.forEach((e, i) => {
    if (!indexesToRemove.includes(i)) {
      validRequests.push(e);
      return;
    }
    remPipeline.srem(`${this.redisName}:${namespace}`, e);
    if (map.has(e)) map.delete(e);
  });
  if (remPipeline.length) {
    await remPipeline.exec();
    this.logger.warn(
      `Removed ${remPipeline.length} invalid requests from Client ${this.name} namespace ${namespace}`
    );
  }
  return validRequests;
}

/**
 * This method checks for existing requests in the Redis queue and processes them.
 *
 * This is to catch any requests that were added while the client was a worker and were not processed by a previous controller.
 */

async function checkExistingRequests(this: Client) {
  const requests = await this.redis.smembers(`${this.redisName}:queue`);
  for (const each of requests) {
    const request = await this.redis.get(`${this.redisName}:queue:${each}`);
    if (!request) await this.redis.srem(`${this.redisName}:queue`, each);
    else {
      const metadata: RequestMetadata = JSON.parse(request);
      this.requestsInQueue.set(each, metadata);
      this.hasUnsortedRequests = true;
    }
  }
}

export default updateRole;
