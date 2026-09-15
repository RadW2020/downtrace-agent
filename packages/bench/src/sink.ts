import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGGREGATES_PATH } from "@downtrace/protocol";

export interface SinkStats {
  batches: number;
  intervals: number;
  endpoints: number;
  /** Sum of endpoint counts, i.e. requests the agent reported. */
  requests: number;
  rejected: number;
  /**
   * The agent's own estimate of what its hooks cost per request, averaged over the batches that carried one
   * (`agent.resources.hookMsPerRequest`, ADR 0080). Absent when no batch did: not knowing is not zero (gh-570).
   */
  hookMsPerRequest?: number | undefined;
}

/**
 * Stand-in for the cloud during the benchmark: accepts the contract's ingest path with a bearer token, answers 202
 * and counts what it received, so the report can prove the agent was live and how much it shipped. The path comes
 * from @downtrace/protocol, where it is defined once (gh-127): a copy here would be a second place to change, and
 * if the two drifted the agent would post into a 404 and the benchmark would measure that instead.
 */
export class Sink {
  readonly stats: SinkStats = { batches: 0, intervals: 0, endpoints: 0, requests: 0, rejected: 0 };
  /** Every hook estimate a batch carried, so the mean is a mean and not a running approximation of one. */
  private readonly hookEstimates: number[] = [];
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  private port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.url);
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== AGGREGATES_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        this.stats.rejected += 1;
        res.writeHead(401).end();
        return;
      }
      try {
        const batch = JSON.parse(Buffer.concat(chunks).toString()) as {
          intervals: { endpoints: { count: number }[] }[];
          agent?: { resources?: { hookMsPerRequest?: number } };
        };
        this.stats.batches += 1;
        const hooks = batch.agent?.resources?.hookMsPerRequest;
        if (typeof hooks === "number" && Number.isFinite(hooks)) {
          this.hookEstimates.push(hooks);
          this.stats.hookMsPerRequest = this.hookEstimates.reduce((a, b) => a + b, 0) / this.hookEstimates.length;
        }
        for (const iv of batch.intervals) {
          this.stats.intervals += 1;
          for (const ep of iv.endpoints) {
            this.stats.endpoints += 1;
            this.stats.requests += ep.count;
          }
        }
        res.writeHead(202).end();
      } catch {
        this.stats.rejected += 1;
        res.writeHead(400).end();
      }
    });
  }
}
