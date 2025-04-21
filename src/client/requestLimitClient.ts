import { RequestDoneData } from "../request/types";
import BaseClient from ".";
import {
  ClientConstructorData,
  ClientTokensUpdatedData,
  RateLimitStats,
  RateLimitUpdatedData,
  RequestLimitClientOptions,
} from "./types";

class RequestLimitClient extends BaseClient {
  protected rateLimit: RequestLimitClientOptions;
  private tokens: number;
  private addTokensInterval?: NodeJS.Timeout;

  constructor(
    data: ClientConstructorData,
    rateLimit: RequestLimitClientOptions
  ) {
    super(data);
    this.rateLimit = rateLimit;
    this.tokens = rateLimit.maxTokens;
  }

  public async handleTokensUpdated(data: ClientTokensUpdatedData) {
    if (this.id === data.clientId) return;
    this.tokens = data.tokens;
  }

  public handleRateLimitUpdated(data: RateLimitUpdatedData) {
    if (data.rateLimit.type !== "requestLimit") return;
    this.rateLimit === data.rateLimit;
    this.tokens > data.rateLimit.maxTokens
      ? data.rateLimit.maxTokens
      : this.tokens;
    this.startAddTokensInterval();
  }

  protected getRateLimitStats(): RateLimitStats {
    return { ...this.rateLimit, tokens: this.tokens };
  }

  protected handleUpdateRole(role: string) {
    this.startAddTokensInterval();
  }

  /**
   * Adds an interval to the Client so that tokens will be added to the Client's bucket as specified by the rate limit.
   */

  private startAddTokensInterval() {
    if (this.role === "worker") return;
    this.removeAddTokensInterval();
    this.addTokensInterval = setInterval(
      () => this.addTokens(),
      this.rateLimit.interval
    );
  }

  private removeAddTokensInterval() {
    if (!this.addTokensInterval) return;
    clearInterval(this.addTokensInterval);
    this.addTokensInterval = undefined;
  }

  protected handleHealthCheck(): Promise<void> | void {
    if (this.addTokensInterval) return;
    this.startAddTokensInterval();
  }

  protected handleOwnTypeRequestDone(data: RequestDoneData) {
    return;
  }

  protected handleFreezeOwnTypeRequests() {
    this.tokens = 0;
    return;
  }

  protected getRetryBackoffBaseTime() {
    return this.rateLimit.interval;
  }

  /**
   * Adds tokens to the client's bucket as specified by the rate limit.
   *
   * This method only runs if the rate limit is a requestLimit type and the client is not frozen.
   *
   * If there are less than 0 tokens in the client's bucket, the method will set the number of tokens to 0.
   *
   * If there are more tokens in the client's bucket than the max allowed, the method will set the number of tokens to the max allowed.
   *
   * If the client's bucket is full, the method will not add any tokens.
   *
   * If the client's bucket is not full, the method will add tokens to the client's bucket and emit a tokensAdded event.
   *
   * @param cost The cost of the request. If the cost is not provided, the method will add 1 token to the client's bucket.
   *
   */

  private async addTokens() {
    const { maxTokens, tokensToAdd } = this.rateLimit;
    if (this.tokens === maxTokens || this.freezeTimeout) return;
    else if (this.tokens < 0) this.tokens = 0;
    else if (this.tokens > maxTokens) this.tokens = maxTokens;
    else {
      const isOver = tokensToAdd + this.tokens > maxTokens;
      if (isOver) this.tokens = maxTokens;
      else this.tokens += tokensToAdd;
      this.emitter.emit(`${this.redisName}:tokensAdded`, this.tokens);
      const data: ClientTokensUpdatedData = {
        clientId: this.id,
        clientName: this.name,
        tokens: this.tokens,
      };
      await this.redis.publish(
        `${this.requestHandlerRedisName}:clientTokensUpdated`,
        JSON.stringify(data)
      );
    }
  }

  protected async waitForTurn(cost: number) {
    if (this.tokens >= cost) return;
    await this.waitForTokens(cost);
    this.tokens -= cost;
    const data: ClientTokensUpdatedData = {
      clientId: this.id,
      clientName: this.name,
      tokens: this.tokens,
    };
    await this.redis.publish(
      `${this.requestHandlerRedisName}:clientTokensUpdated`,
      JSON.stringify(data)
    );
  }

  /**
   * This method checks for enough tokens in the client's bucket.
   *
   * If the client has enough tokens, the method will resolve immediately.
   *
   * If the client does not have enough tokens, the method will wait for enough tokens to be added to the client's bucket.
   */

  private waitForTokens(cost: number): Promise<boolean> {
    if (this.tokens >= cost) return Promise.resolve(true);
    return new Promise((resolve) => {
      const listener = async () => {
        if (this.tokens < cost) return;
        this.emitter.off(`${this.redisName}:tokensAdded`, listener);
        resolve(true);
      };
      this.emitter.on(`${this.redisName}:tokensAdded`, listener);
    });
  }

  protected handleDestroy() {
    this.removeAddTokensInterval();
  }
}

export default RequestLimitClient;
