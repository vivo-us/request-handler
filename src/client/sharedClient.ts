import { RequestDoneData } from "../request/types";
import BaseClient from ".";
import {
  ClientConstructorData,
  ClientRole,
  ClientTokensUpdatedData,
  SharedLimitClientOptions,
  RateLimitStats,
  RateLimitUpdatedData,
} from "./types";

class SharedLimitClient extends BaseClient {
  protected rateLimit: SharedLimitClientOptions;
  constructor(
    data: ClientConstructorData,
    rateLimit: SharedLimitClientOptions
  ) {
    super(data);
    this.rateLimit = rateLimit;
  }

  public handleTokensUpdated(data: ClientTokensUpdatedData): void {
    return;
  }

  public handleRateLimitUpdated(data: RateLimitUpdatedData) {
    if (data.rateLimit.type !== "sharedLimit") return;
    this.rateLimit = data.rateLimit;
  }

  protected getRateLimitStats(): RateLimitStats {
    return this.rateLimit;
  }

  protected handleUpdateRole(role: ClientRole) {
    return;
  }

  protected handleHealthCheck() {
    return;
  }

  protected handleOwnTypeRequestDone(data: RequestDoneData) {
    return;
  }

  protected handleFreezeOwnTypeRequests() {
    return;
  }

  protected getRetryBackoffBaseTime() {
    return this.retryOptions.retryBackoffBaseTime;
  }

  protected waitForTurn(cost: number) {
    return;
  }

  protected handleDestroy() {
    return;
  }
}

export default SharedLimitClient;
