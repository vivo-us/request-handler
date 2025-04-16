import { RequestConfig, RequestRetryData } from "../request/types";
import { AxiosError, AxiosResponse } from "axios";
import { RateLimitData } from "./types";
import BaseError from "../baseError";
import Request from "../request";
import Client from ".";

async function handleRequest(this: Client, config: RequestConfig) {
  const request = new Request(
    this.rateLimit.type === "shared" ? this.rateLimit.clientName : this.name,
    config,
    this.requestOptions
  );
  this.logger.debug(`Request ID: ${request.id} | Waiting...`);
  do {
    request.setStatus("inQueue");
    const interval = setInterval(async () => {
      await this.redis.publish(
        `${this.requestHandlerRedisName}:requestHeartbeat`,
        JSON.stringify(request.getMetadata())
      );
    }, 1000);
    await handlePreRequest.bind(this)(request);
    let res;
    try {
      res = await this.http.request(request.config);
    } catch (error: any) {
      await handleError.bind(this)(request, error, interval);
      continue;
    }
    return await handleResponse.bind(this)(request, res, interval);
  } while (request.retries <= this.retryOptions.maxRetries);
  throw new BaseError(this.logger, "No response received for the request.");
}

async function handlePreRequest(this: Client, request: Request) {
  await waitForRequestReady.bind(this)(request);
  if (this.requestOptions.requestInterceptor) {
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
  const { method, baseURL, url } = request.config;
  this.logger.debug(
    `Request ID: ${request.id} | ${method} | ${baseURL || ""}${url || ""}${
      request.retries ? ` | Retry Attempt: ${request.retries}` : ""
    }`
  );
}

function waitForRequestReady(this: Client, request: Request) {
  if (this.rateLimit.type === "noLimit") return true;
  return new Promise(async (resolve) => {
    this.emitter.once(`requestReady:${request.id}`, async () => {
      request.setStatus("inProgress");
      resolve(true);
    });
    await this.redis.publish(
      `${this.requestHandlerRedisName}:requestAdded`,
      JSON.stringify(request.getMetadata())
    );
  });
}

async function handleResponse(
  this: Client,
  request: Request,
  res: AxiosResponse,
  interval: NodeJS.Timeout
) {
  clearInterval(interval);
  await this.redis.publish(
    `${this.requestHandlerRedisName}:requestDone`,
    JSON.stringify(request.getRequestDoneData())
  );
  if (this.requestOptions?.responseInterceptor) {
    await this.requestOptions.responseInterceptor(request.config, res);
  }
  if (this.rateLimitChange) {
    let rateLimit: RateLimitData;
    if (this.rateLimit.type === "requestLimit") {
      rateLimit = {
        type: "requestLimit",
        tokensToAdd: this.rateLimit.tokensToAdd,
        maxTokens: this.rateLimit.maxTokens,
        interval: this.rateLimit.interval,
      };
    } else rateLimit = this.rateLimit;
    const newLimit = await this.rateLimitChange(rateLimit, res);
    if (newLimit) await this.updateRateLimit(newLimit);
  }
  this.logger.debug(`Request ID: ${request.id} | Status: ${res.status}`);
  return res;
}

async function handleError(
  this: Client,
  request: Request,
  res: AxiosError | any,
  interval: NodeJS.Timeout
) {
  const retryData = await handleRetry.bind(this)(request, res);
  handleLogError.bind(this)(request, res, retryData);
  clearInterval(interval);
  await this.redis.publish(
    `${this.requestHandlerRedisName}:requestDone`,
    JSON.stringify(request.getRequestDoneData(retryData))
  );
  if (retryData.retry) return;
  throw res;
}

async function handleRetry(this: Client, request: Request, error: AxiosError) {
  const { retry429s, retry5xxs, retryStatusCodes } = this.retryOptions;
  const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"];
  const status = error?.response?.status;
  const data: RequestRetryData = {
    retry: true,
    message: "",
    isRateLimited: false,
    waitTime: 0,
  };
  if (request.retries === this.retryOptions.maxRetries) {
    data.message += "Maximum number of retries reached.";
    data.retry = false;
  } else if (status && status === 429 && retry429s) {
    data.message += "Rate Limited";
    data.isRateLimited = true;
  } else if (status && status >= 500 && retry5xxs) {
    data.message += "Server Error";
  } else if (status && retryStatusCodes.includes(status)) {
    data.message += "Client Wants Retry By Status";
  } else if (error.code && retryableCodes.includes(error.code)) {
    data.message += "Server Error";
  } else if (this.retryOptions?.retryHandler) {
    const retry = await this.retryOptions?.retryHandler(error);
    if (retry) data.message += "Client Wants Retry";
    else data.retry = false;
  } else data.retry = false;
  if (!data.retry) return data;
  request.incrementRetries();
  return handleBackoff.bind(this)(request, data);
}

/**
 * This method handles the backoff for the request including how long to wait before retrying and request freezing.
 *
 * @param type The reason for the backoff.
 * @returns
 */

function handleBackoff(this: Client, request: Request, data: RequestRetryData) {
  const { retryBackoffBaseTime, retryBackoffMethod } = this.retryOptions;
  const backoffBase =
    this.rateLimit.type === "requestLimit"
      ? this.rateLimit.interval
      : retryBackoffBaseTime;
  const power = retryBackoffMethod === "exponential" ? 2 : 1;
  data.waitTime = Math.pow(request.retries, power) * backoffBase;
  data.message += ` | Will retry...`;
  return data;
}

function handleLogError(
  this: Client,
  request: Request,
  res: AxiosError | any,
  retryData: RequestRetryData
) {
  const status = res.response?.status;
  const shouldMute = status && this.httpStatusCodesToMute?.includes(status);
  const logger = shouldMute ? this.logger.debug : this.logger.error;
  const message = `Request ID: ${request.id} | Status: ${status} | Code: ${
    res.code
  }${retryData.message ? ` | ${retryData.message}` : ""}`;
  logger(message, {
    error: {
      message: res.message,
      stack: res.stack,
      code: res.code,
      config: res.config,
      response: {
        status: res.response?.status,
        statusText: res.response?.statusText,
        headers: res.response?.headers,
        data: res.response?.data,
      },
    },
  });
}

export default handleRequest;
