import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ProviderControl {
  /** Manual latency, used when `slow_dependency` is off. */
  delayMs: number;
  /** Fraction of responses that fail with 500. */
  failureRate: number;
}

/**
 * A Stripe-like external provider running in-process on its own port, so the
 * app makes real outgoing HTTP calls whose latency and failures we control.
 */
export class FakeProvider {
  readonly control: ProviderControl = { delayMs: 0, failureRate: 0 };
  private readonly server: http.Server;
  private readonly pending = new Set<NodeJS.Timeout>();
  private port = 0;
  private readonly effectiveDelayMs: (manual: number) => number;

  constructor(effectiveDelayMs: (manual: number) => number) {
    this.effectiveDelayMs = effectiveDelayMs;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  async close(): Promise<void> {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    req.on("end", () => {
      const delay = this.effectiveDelayMs(this.control.delayMs);
      const timer = setTimeout(() => {
        this.pending.delete(timer);
        this.respond(req, res);
      }, delay);
      this.pending.add(timer);
    });
  }

  private respond(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader("content-type", "application/json");
    if (Math.random() < this.control.failureRate) {
      res.writeHead(500).end(JSON.stringify({ error: "provider_unavailable" }));
      return;
    }
    const path = new URL(req.url ?? "/", "http://provider").pathname;
    const op = path === "/authorize" ? "auth" : path === "/capture" ? "capture" : null;
    if (req.method !== "POST" || op === null) {
      res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({ ok: true, op, ref: `${op}_${randomUUID()}` }));
  }
}
