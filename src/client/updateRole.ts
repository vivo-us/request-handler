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

async function updateRole(this: Client, role: ClientRole) {
  if (role === this.role) return;
  this.role = role;
  this.removeAddTokensInterval();
  if (this.rateLimit.type === "noLimit" || this.role === "worker") return;
  if (this.createData.sharedRateLimitClientName) return;
  this.startAddTokensInterval();
  this.emitter.emit(`${this.redisName}:processRequests`);
}

export default updateRole;
