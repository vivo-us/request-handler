import { ClientRole } from "./types";
import Client from ".";

/**
 * This method ensures that all proper actions are taken based on the role of the client.
 *
 * Always clears the addTokensInterval and healthCheckInterval if they are running.
 *
 * If the client is a worker, no further action is taken.
 *
 * If the client has the controller role, it will take the following actions:
 * - Start the addTokensInterval
 * - Emit the processRequests event
 *
 *
 */

function updateRole(this: Client, role: ClientRole) {
  if (role === this.role) return;
  this.role = role;
  this.removeAddTokensInterval();
  this.removeHealthCheckInterval();
  if (this.rateLimit.type === "noLimit" || this.role === "worker") return;
  if (this.createData.sharedRateLimitClientName) return;
  this.startAddTokensInterval();
  startHealthCheckInterval.bind(this)();
  this.emitter.emit(`${this.redisName}:processRequests`);
}

function startHealthCheckInterval(this: Client) {
  this.removeHealthCheckInterval();
  if (this.role === "worker" || this.rateLimit.type === "noLimit") return;
  if (this.createData.sharedRateLimitClientName) return;
  this.healthCheckInterval = setInterval(() => {
    healthCheck.call(this);
  }, this.createData.healthCheckIntervalMs || 60000);
}

function healthCheck(this: Client) {
  if (this.role === "worker" || this.rateLimit.type === "noLimit") return;
  if (this.createData.sharedRateLimitClientName) return;
  if (this.rateLimit.type === "requestLimit") {
    if (!this.addTokensInterval) this.startAddTokensInterval();
    return;
  }
  const tokensOffBy =
    this.maxTokens - this.tokens - this.requestsInProgress.size;
  if (tokensOffBy > 0) this.addTokens(tokensOffBy);
}

export default updateRole;
