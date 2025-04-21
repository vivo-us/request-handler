import { RequestDoneData } from "../../request/types";
import BaseClient from "..";
import {
  ClientConstructorData,
  ClientRole,
  ClientTokensUpdatedData,
  NoLimitClientOptions,
  RateLimitStats,
  RateLimitUpdatedData,
} from "../types";

class NoLimitClient extends BaseClient {
  protected rateLimit: NoLimitClientOptions;
  constructor(data: ClientConstructorData, rateLimit: NoLimitClientOptions) {
    super(data, data.client.name);
    this.rateLimit = rateLimit;
  }

  public handleTokensUpdated(data: ClientTokensUpdatedData): void {
    return;
  }

  public handleRateLimitUpdated(data: RateLimitUpdatedData) {
    if (data.rateLimit.type !== "noLimit") return;
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

export default NoLimitClient;
