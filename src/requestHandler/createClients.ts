import ConcurrencyLimitClient from "../client/clientTypes/concurrencyLimitClient";
import RequestLimitClient from "../client/clientTypes/requestLimitClient";
import SharedLimitClient from "../client/clientTypes/sharedLimitClient";
import NoLimitClient from "../client/clientTypes/noLimitClient";
import { CreateClientData } from "../client/types";
import BaseError from "../baseError";
import RequestHandler from ".";

/**
 * This method uses the client generators provided when the RequestHandler was created to create new clients.
 *
 * If the `generatorNames` parameter is provided, only the clients generated by the generators with those names will be created.
 *
 * If the client already exists, the old one is reset so that the new one can take over.
 *
 * The clients are then generated and assigned their roles.
 *
 * @param generatorNames Optionally the names of the generators to regenerate clients for
 */

async function createClients(
  this: RequestHandler,
  generatorNames: string[] = []
) {
  const clientsToGenerate: CreateClientData[] = [this.defaultClient];
  for (const each in this.clientGenerators) {
    if (generatorNames.length && !generatorNames.includes(each)) continue;
    const clients = await this.clientGenerators[each]();
    clientsToGenerate.push(...clients);
  }
  await generateClients.bind(this)(clientsToGenerate);
}

/**
 * This method generates the clients provided in the `clients` parameter and if a parent client is provided, merges the parent and child clients data so that the child client inherits the parent's data.
 *
 * @param clients The client data to generate clients for
 * @param parent The parent of a client if it exists. This is used to merge the parent and child clients data
 */

async function generateClients(
  this: RequestHandler,
  clients: CreateClientData[],
  parent?: CreateClientData
) {
  for (let client of clients) {
    if (parent) client = mergeChildParentClients.bind(this)(client, parent);
    resetClient.bind(this)(client.name);
    await createClient.bind(this)(client);
    if (client.subClients) {
      await generateClients.bind(this)(client.subClients, client);
    }
  }
}

/**
 *  This method merges the data of the child client with the parent client. Child client data takes precedence over parent client data.
 *
 * @param child The child client data
 * @param parent The parent client data
 * @returns
 */

function mergeChildParentClients(
  child: CreateClientData,
  parent: CreateClientData
): CreateClientData {
  let parentClone = { ...parent };
  delete parentClone.subClients;
  const merged: CreateClientData = {
    ...parentClone,
    ...child,
    name: `${parent.name}:${child.name}`,
    metadata: {
      ...parent.metadata,
      ...child.metadata,
    },
    axiosOptions: {
      ...parent.axiosOptions,
      ...child.axiosOptions,
    },
    requestOptions: {
      ...parent.requestOptions,
      ...child.requestOptions,
      defaults: {
        ...parent.requestOptions?.defaults,
        ...child.requestOptions?.defaults,
      },
    },
    retryOptions: {
      ...parent.retryOptions,
      ...child.retryOptions,
    },
  };
  return merged;
}

/**
 * This method resets the client with the given name so that a new client can take over.
 */

function resetClient(this: RequestHandler, clientName: string) {
  const client = this.clients.get(clientName);
  if (!client) return;
  client.updateRole("worker");
  this.clients.delete(clientName);
}

/**
 * Creates a new client with the given data.
 *
 * If a client with the given name already exists, throws an error.
 *
 * @param data The data to use to create the client
 */
async function createClient(this: RequestHandler, data: CreateClientData) {
  const existing = this.clients.get(data.name);
  if (existing) {
    throw new BaseError(
      this.logger,
      `Client with name ${data.name} already exists.`
    );
  }
  const baseData = {
    client: data,
    redis: this.redis,
    requestHandlerRedisName: this.redisName,
    logger: this.logger,
    key: this.key,
    emitter: this.emitter,
  };
  switch (data.rateLimit?.type) {
    case "requestLimit":
      const rlClient = new RequestLimitClient(baseData, data.rateLimit);
      this.clients.set(data.name, rlClient);
      await rlClient.init();
      break;
    case "concurrencyLimit":
      const clClient = new ConcurrencyLimitClient(baseData, data.rateLimit);
      this.clients.set(data.name, clClient);
      await clClient.init();
      break;
    case "sharedLimit":
      const slClient = new SharedLimitClient(baseData, data.rateLimit);
      this.clients.set(data.name, slClient);
      await slClient.init();
      break;
    case "noLimit":
      const nlClient = new NoLimitClient(baseData, data.rateLimit);
      this.clients.set(data.name, nlClient);
      await nlClient.init();
      break;
    default:
      const undefinedClient = new NoLimitClient(baseData, { type: "noLimit" });
      this.clients.set(data.name, undefinedClient);
      await undefinedClient.init();
      break;
  }
}

export default createClients;
