import { RequestConfig } from "../request/types";
import handleResponse from "./handleResponse";
import { AxiosResponse } from "axios";
import BaseError from "../baseError";
import Request from "../request";
import Client from ".";

async function handleRequest(this: Client, config: RequestConfig) {
  const request = await generateRequest.bind(this)(config);
  let res;
  do {
    await handlePreRequest.bind(this)(request);
    try {
      res = await this.http.request(request.config);
    } catch (error: any) {
      await handleResponse.bind(this)(request, error);
      continue;
    }
    await handleResponse.bind(this)(request, res);
  } while (!res && request.retries <= request.maxRetries);
  return await handlePostResponse.bind(this)(request, res);
}

async function generateRequest(this: Client, config: RequestConfig) {
  const maxRetries = this.requestOptions?.retryOptions?.maxRetries || 3;
  const request = new Request(config, maxRetries);
  handleRequestDefaults.bind(this)(request);
  const { method, baseURL, url } = request.config;
  this.logger.debug(
    `Request ID: ${request.id} | ${method} | ${baseURL || ""}${url || ""}`
  );
  return request;
}

/**
 * Adds the request defaults to the request config.
 *
 * @param request A Request instance.
 * @returns
 */

function handleRequestDefaults(this: Client, request: Request) {
  if (!this.requestOptions?.defaults) return;
  const { headers, baseURL, params } = this.requestOptions.defaults;
  request.config = {
    ...request.config,
    baseURL: baseURL || request.config.baseURL,
    headers: { ...request.config.headers, ...(headers || {}) },
    params: { ...request.config.params, ...(params || {}) },
  };
}

async function handlePreRequest(this: Client, request: Request) {
  await waitForRequestReady.bind(this)(request);
  if (this.requestOptions?.requestInterceptor) {
    request.config = await this.requestOptions.requestInterceptor(
      request.config
    );
  }
  if (this.authenticator) {
    const authHeader = await this.authenticator.authenticate(request.config);
    request.config = {
      ...request.config,
      headers: { ...request.config.headers, ...authHeader },
    };
  }
}

async function handlePostResponse(
  this: Client,
  request: Request,
  res?: AxiosResponse
) {
  if (!res) {
    throw new BaseError(this.logger, "No response received for the request.");
  }
  if (this.requestOptions?.responseInterceptor) {
    await this.requestOptions?.responseInterceptor(request.config, res);
  }
  this.logger.debug(`Request ID: ${request.id} | Status: ${res.status}`);
  return res;
}

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

export default handleRequest;
