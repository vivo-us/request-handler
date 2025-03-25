import Request from "../request";
import Client from ".";

/**
 * This method waits for the request to be ready to be sent.
 *
 * If the client has no rate limit, the method will resolve immediately.
 *
 * If the client has a rate limit, the method will add the request to the queue and wait for the request to be ready.
 *
 * If the request is not ready within 30 seconds, the method will resolve false.
 */

async function waitForRequestReady(
  this: Client,
  request: Request
): Promise<boolean> {
  return new Promise(async (resolve) => {
    if (this.rateLimit.type === "noLimit") {
      resolve(true);
      return;
    }
    await addToQueue.bind(this)(request);
    const interval = setInterval(async () => {
      await this.redis.expire(`${this.redisName}:queue:${request.id}`, 5);
    }, 2500);
    this.emitter.once(`requestReady:${request.id}`, async (message) => {
      clearInterval(interval);
      await this.redis.srem(`${this.redisName}:queue`, request.id);
      await this.redis.del(`${this.redisName}:queue:${request.id}`);
      resolve(true);
    });
    await this.redis.publish(
      `${this.redisName}:requestAdded`,
      JSON.stringify({
        priority: request.config.priority || 1,
        cost: request.config.cost || 1,
        timestamp: Date.now(),
        retries: request.retries,
        clientId: this.id,
        requestId: request.id,
      })
    );
  });
}

/**
 * Adds the request to the queue and sets the priority, cost, and timestamp.
 */
async function addToQueue(this: Client, request: Request) {
  const writePipeline = this.redis.pipeline();
  writePipeline.sadd(`${this.redisName}:queue`, request.id);
  writePipeline.hset(`${this.redisName}:queue:${request.id}`, {
    priority: request.config.priority || 1,
    cost: request.config.cost || 1,
    timestamp: Date.now(),
  });
  writePipeline.expire(`${this.redisName}:queue:${request.id}`, 5);
  await writePipeline.exec();
}

export default waitForRequestReady;
