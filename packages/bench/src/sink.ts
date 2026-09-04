import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SinkStats {
  batches: number;
  intervals: number;
  endpoints: number;
  /** Sum of endpoint counts, i.e. requests the agent reported. */
  requests: number;
  rejected: number;
}

/**
 * Stand-in for the cloud during the benchmark: accepts POST /v0/aggregates
 * with a bearer token, answers 202 and counts what it received, so the report
 * can prove the agent was live and how much it shipped.
 */
export class Sink {
  readonly stats: SinkStats = { batches: 0, intervals: 0, endpoints: 0, requests: 0, rejected: 0 };
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
      if (req.method !== "POST" || req.url !== "/v0/aggregates") {
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
        };
        this.stats.batches += 1;
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
