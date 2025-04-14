import { AxiosRequestConfig, Method } from "axios";

export type RequestStatus = "inQueue" | "inProgress";

export interface RequestConfig extends AxiosRequestConfig {
  clientName: "default" | string;
  method: Method;
  /**
   * The priority of the request.
   *
   * Requests with a higher priority will be placed at the front of the queue.
   *
   * **Default value: 1**
   */
  priority?: number;
  /**
   * Metadata to be associated with the request.
   */
  metadata?: Record<string, any>;
  /**
   * The cost of the request to the rate limiter. This is helpful when some requests are more expensive than others.
   *
   * **Default value: 1**
   */
  cost?: number;
}

export interface RequestMetadata {
  requestId: string;
  status: RequestStatus;
  priority: number;
  timestamp: number;
  clientName: string;
  cost: number;
  retries: number;
}

export interface RequestRetryData {
  retry: boolean;
  message: string;
  isRateLimited: boolean;
  waitTime: number;
}

export interface RequestDoneData extends RequestMetadata {
  responseStatus: "success" | "failure";
  waitTime: number;
  isRateLimited: boolean;
}
