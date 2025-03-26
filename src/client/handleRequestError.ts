import { RequestDoneData, RequestRetryData } from "./types";
import { AxiosError } from "axios";
import Request from "../request";
import Client from ".";

async function handleRequestError(
  this: Client,
  request: Request,
  res: AxiosError | any
) {
  const retryData = await handleRetry.bind(this)(request, res);
  await handleLogError.bind(this)(request, res, retryData);
  const data: RequestDoneData = {
    cost: request.config.cost || 1,
    status: "failure",
    requestId: request.id,
    clientName: this.name,
    waitTime: retryData.waitTime,
    isRateLimited: retryData.isRateLimited,
  };
  await this.redis.publish(
    `${this.requestHandlerRedisName}:requestDone`,
    JSON.stringify(data)
  );
  if (!retryData.retry) throw res;
}

async function handleRetry(this: Client, request: Request, error: AxiosError) {
  const { retryOptions } = this.requestOptions;
  const retry429s = retryOptions?.retry429s || true;
  const retry5xxs = retryOptions?.retry5xxs || true;
  const retryStatusCodes = retryOptions?.retryStatusCodes || [];
  const retryableCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED"];
  const status = error?.response?.status;
  const data: RequestRetryData = {
    retry: true,
    message: "",
    isRateLimited: false,
    waitTime: 0,
  };
  if (request.retries === request.maxRetries) {
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
  } else if (retryOptions?.retryHandler) {
    const retry = await retryOptions?.retryHandler(error);
    if (retry) data.message += "Client Wants Retry";
    else data.retry = false;
  } else data.retry = false;
  if (!data.retry) return data;
  return handleBackoff.bind(this)(request, data);
}

/**
 * This method handles the backoff for the request including how long to wait before retrying and request freezing.
 *
 * @param type The reason for the backoff.
 * @returns
 */

function handleBackoff(this: Client, request: Request, data: RequestRetryData) {
  const { retryOptions } = this.requestOptions;
  const retryBackoffBaseTime = retryOptions?.retryBackoffBaseTime || 1000;
  const retryBackoffMethod = retryOptions?.retryBackoffMethod || "exponential";
  const backoffBase =
    (this.rateLimit.type === "requestLimit" && this.rateLimit.interval) ||
    retryBackoffBaseTime;
  const power = retryBackoffMethod === "exponential" ? 2 : 1;
  request.retries++;
  data.waitTime = Math.pow(request.retries, power) * backoffBase;
  data.message += ` | Attempt ${request.retries} | Retrying...`;
  return data;
}

async function handleLogError(
  this: Client,
  request: Request,
  res: AxiosError | any,
  retryData: RequestRetryData
) {
  const status = res.response?.status;
  const shouldMute =
    status && this.requestOptions?.httpStatusCodesToMute?.includes(status);
  const logger = shouldMute ? this.logger.debug : this.logger.error;
  const message = `Request ID: ${request.id} | Status: ${status} | Code: ${res.code} | ${retryData.message}`;
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

export default handleRequestError;
