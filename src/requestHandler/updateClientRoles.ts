import { RequestHandlerMetadata } from "./types";
import RequestHandler from ".";

/**
 * This method gets the clients owned by the instance by comparing the list of registered clients with the list of clients registered before the instance.
 *
 * Any clients that were registered before the instance are set to "worker" and any clients that were registered on or after the instance are set to "controller".
 */

async function updateClientRoles(this: RequestHandler, isStartup = false) {
  const clientsBefore = await getClientsBefore.bind(this)();
  let hasChanges = false;
  for (const [name, client] of this.clients) {
    const newRole = clientsBefore.has(name) ? "worker" : "controller";
    if (client.role === newRole) continue;
    client.updateRole(newRole);
    hasChanges = true;
  }
  if (!hasChanges && !isStartup) return;
  await updateInstanceRegistration.bind(this)(hasChanges, isStartup);
}

/**
 * This method gets a list of clients before the instance
 */

async function getClientsBefore(this: RequestHandler) {
  const instances = await getInstances.bind(this)();
  const sorted = instances.sort((a, b) => {
    if (a.priority > b.priority) return -1;
    else if (a.priority < b.priority) return 1;
    else return b.id.localeCompare(a.id);
  });
  const clientsBefore: Set<string> = new Set();
  for (const instance of sorted) {
    if (instance.id === this.id) break;
    instance.registeredClients.forEach((c) => clientsBefore.add(c));
  }
  return clientsBefore;
}

/**
 * This method gets the instances from the Redis store and sorts them by priority and ID.
 *
 * If a instance is not found in the Redis store, it is removed from the list of instances so that others can take over the clients.
 *
 * @returns A list of instances sorted by priority and ID
 */

async function getInstances(this: RequestHandler) {
  const ids = await this.redis.smembers(`${this.redisName}:instances`);
  const instances: RequestHandlerMetadata[] = [this.getMetadata()];
  for (const id of ids) {
    if (id === this.id) continue;
    const data = await this.redis.get(`${this.redisName}:instance:${id}`);
    if (!data) {
      this.logger.warn(
        `Instance with ID ${id} was not found in the Redis store.`
      );
      await this.redis.srem(`${this.redisName}:instances`, id);
      continue;
    }
    instances.push(JSON.parse(data));
  }
  return instances;
}

/**
 * This is a centralized function to update the client lists for the instance in the Redis store.
 */

async function updateInstanceRegistration(
  this: RequestHandler,
  hasChanges: boolean,
  isStartup: boolean
) {
  const key = `${this.redisName}:instance:${this.id}`;
  const pipeline = this.redis.pipeline();
  pipeline.set(key, JSON.stringify(this.getMetadata()));
  pipeline.expire(key, 3);
  if (isStartup) {
    pipeline.sadd(`${this.redisName}:instances`, this.id);
    pipeline.publish(`${this.redisName}:instanceStarted`, this.id);
  }
  if (hasChanges) {
    pipeline.publish(`${this.redisName}:instanceUpdated`, this.id);
  }
  await pipeline.exec();
  if (this.heartbeatInterval) return;
  this.heartbeatInterval = setInterval(async () => {
    const pipeline = this.redis.pipeline();
    pipeline.expire(key, 3);
    pipeline.publish(`${this.redisName}:instanceHeartbeat`, this.id);
    await pipeline.exec();
  }, 1000);
}

export default updateClientRoles;
