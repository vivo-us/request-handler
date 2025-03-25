import { RequestDoneData, RequestRetryData } from "./types";
import { AxiosError, AxiosResponse } from "axios";
import BaseError from "../baseError";
import Request from "../request";
import Client from ".";

async function handleResponse(
  this: Client,
  request: Request,
  res: AxiosResponse | AxiosError | any
) {
  const errorData = await getRequestErrorData.bind(this)(request, res);
  const data: RequestDoneData = {
    cost: request.config.cost || 1,
    status: errorData ? "failure" : "success",
    requestId: request.id,
    waitTime: errorData?.waitTime || 0,
    isRateLimited: errorData?.isRateLimited || false,
  };
  await this.redis.publish(
    `${this.redisName}:requestDone`,
    JSON.stringify(data)
  );
  if (errorData && !errorData.retry) {
    throw new BaseError(
      this.logger,
      `Request ID: ${request.id} | ${errorData.message}`,
      { error: generateErrorMetadata(res) }
    );
  }
  if (!isResponse(res) || !this.rateLimitChange) return;
  const newLimit = await this.rateLimitChange(this.rateLimit, res);
  if (newLimit) await this.updateRateLimit(newLimit);
  return res;
}

function isError(res: AxiosResponse | AxiosError | any): res is AxiosError {
  return res.isAxiosError;
}

/**
 * This method checks if the response is an AxiosResponse.
 */

function isResponse(
  res: AxiosResponse | AxiosError | any
): res is AxiosResponse {
  return res.data !== undefined && res.status !== undefined;
}

async function getRequestErrorData(
  this: Client,
  request: Request,
  res: AxiosResponse | AxiosError | any
) {
  if (!isError(res)) return;
  const data = await handleRetry.bind(this)(request, res);
  const status = res.response?.status;
  const shouldMute =
    status && this.requestOptions?.httpStatusCodesToMute?.includes(status);
  const logger = shouldMute ? this.logger.debug : this.logger.error;
  const message = `Request ID: ${request.id} | Status: ${status} | Code: ${res.code} | ${data.message}`;
  logger(message, { error: generateErrorMetadata(res) });
  return data;
}

const generateErrorMetadata = (error: AxiosError) => {
  return {
    message: error.message,
    stack: error.stack,
    code: error.code,
    config: error.config,
    response: {
      status: error.response?.status,
      statusText: error.response?.statusText,
      headers: error.response?.headers,
      data: error.response?.data,
    },
  };
};

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

export default handleResponse;
