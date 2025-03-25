import { RequestConfig } from "../request/types";
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
      await this.handleResponse(request, error);
      continue;
    }
    await this.handleResponse(request, res);
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
  await this.waitForRequestReady(request);
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

export default handleRequest;
