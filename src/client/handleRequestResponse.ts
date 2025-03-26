import { RequestDoneData } from "./types";
import { AxiosResponse } from "axios";
import Request from "../request";
import Client from ".";

async function handleResponse(
  this: Client,
  request: Request,
  res: AxiosResponse
) {
  const data: RequestDoneData = {
    cost: request.config.cost || 1,
    status: "success",
    requestId: request.id,
    waitTime: 0,
    isRateLimited: false,
  };
  await this.redis.publish(
    `${this.redisName}:requestDone`,
    JSON.stringify(data)
  );
  if (this.rateLimitChange) {
    const newLimit = await this.rateLimitChange(this.rateLimit, res);
    if (newLimit) await this.updateRateLimit(newLimit);
  }
  return res;
}

export default handleResponse;
