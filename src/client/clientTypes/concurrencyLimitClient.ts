import { RequestDoneData } from "../../request/types";
import BaseClient from "..";
import {
  ClientConstructorData,
  ClientTokensUpdatedData,
  ConcurrencyLimitClientOptions,
  RateLimitStats,
  RateLimitUpdatedData,
} from "../types";

class ConcurrencyLimitClient extends BaseClient {
  protected rateLimit: ConcurrencyLimitClientOptions;
  constructor(
    data: ClientConstructorData,
    rateLimit: ConcurrencyLimitClientOptions
  ) {
    super(data);
    this.rateLimit = rateLimit;
  }

  public handleTokensUpdated(data: ClientTokensUpdatedData): void {
    return;
  }

  public handleRateLimitUpdated(data: RateLimitUpdatedData) {
    if (data.rateLimit.type !== "concurrencyLimit") return;
    this.rateLimit = data.rateLimit;
  }

  protected getRateLimitStats(): RateLimitStats {
    return this.rateLimit;
  }

  protected handleUpdateRole(role: string) {
    return;
  }

  protected handleHealthCheck() {
    return;
  }

  protected handleOwnTypeRequestDone(data: RequestDoneData) {
    this.emitter.emit(`${this.redisName}:requestDone`);
  }

  protected handleFreezeOwnTypeRequests() {
    return;
  }

  protected getRetryBackoffBaseTime() {
    return this.retryOptions.retryBackoffBaseTime;
  }

  protected async waitForTurn(cost: number) {
    const { maxConcurrency } = this.rateLimit;
    const currCost = this.getRequestsInProgressCost();
    if (maxConcurrency >= currCost + cost) return;
    await this.waitForConcurrency(cost);
  }

  private waitForConcurrency(cost: number) {
    return new Promise((resolve) => {
      const listener = () => {
        const currCost = this.getRequestsInProgressCost();
        if (this.rateLimit.maxConcurrency < currCost + cost) return;
        resolve(true);
        this.emitter.off(`${this.redisName}:requestDone`, listener);
      };
      this.emitter.on(`${this.redisName}:requestDone`, listener);
    });
  }

  private getRequestsInProgressCost() {
    let cost = 0;
    for (const request of this.requests.values()) {
      if (request.status !== "inProgress") continue;
      cost += request.cost;
    }
    return cost;
  }

  protected handleDestroy(): Promise<void> | void {
    return;
  }
}

export default ConcurrencyLimitClient;
