/**
 * Test double for the benchmark: an "agent" that stalls every 50th HTTP
 * request by 200 ms — a tail regression, the kind the p99 budget exists to
 * catch (an agent that occasionally blocks the event loop). Used to prove the
 * harness fails when the budget is broken, on quiet and noisy machines alike.
 */
import http from "node:http";

const EVERY = 50;
const STALL_MS = 200;
let seen = 0;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
  if (event === "request") {
    seen += 1;
    if (seen % EVERY === 0) {
      setTimeout(() => emit.call(this, event, ...args), STALL_MS);
      return true;
    }
  }
  return emit.call(this, event, ...args);
} as typeof http.Server.prototype.emit;
