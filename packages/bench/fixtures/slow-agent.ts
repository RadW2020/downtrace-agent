/**
 * Test double for the benchmark: an "agent" that delays every HTTP request by
 * 5 ms. Used to prove the harness fails when the budget is broken.
 */
import http from "node:http";

const DELAY_MS = 5;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
  if (event === "request") {
    setTimeout(() => emit.call(this, event, ...args), DELAY_MS);
    return true;
  }
  return emit.call(this, event, ...args);
} as typeof http.Server.prototype.emit;
