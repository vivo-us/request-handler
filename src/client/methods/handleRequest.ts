import { RequestConfig, RequestRetryData } from "../../request/types";
import { AxiosError, AxiosResponse } from "axios";
import authenticate from "./authenticate";
import BaseError from "../../baseError";
import Request from "../../request";
import BaseClient from "..";

async function handleRequest(this: BaseClient, config: RequestConfig) {
  const request = new Request(this.name, config, this.requestOptions);
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

async function handlePreRequest(this: BaseClient, request: Request) {
  await waitForRequestReady.bind(this)(request);
  if (this.requestOptions.requestInterceptor) {
    request.config = await this.requestOptions.requestInterceptor(
      request.config
    );
  }
  const authHeader = await authenticate.bind(this)();
  if (authHeader) {
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

function waitForRequestReady(this: BaseClient, request: Request) {
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
  this: BaseClient,
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
    const newLimit = await this.rateLimitChange(this.rateLimit, res);
    if (newLimit) await this.updateRateLimit(newLimit);
  }
  this.logger.debug(`Request ID: ${request.id} | Status: ${res.status}`);
  return res;
}

async function handleError(
  this: BaseClient,
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

async function handleRetry(
  this: BaseClient,
  request: Request,
  error: AxiosError
) {
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

function handleBackoff(
  this: BaseClient,
  request: Request,
  data: RequestRetryData
) {
  const backoffBase = this.getRetryBackoffBaseTime();
  const power = this.retryOptions.retryBackoffMethod === "exponential" ? 2 : 1;
  data.waitTime = Math.pow(request.retries, power) * backoffBase;
  data.message += ` | Will retry...`;
  return data;
}

function handleLogError(
  this: BaseClient,
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
