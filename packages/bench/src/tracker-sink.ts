import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TrackerSinkStats {
  /** Envelopes received: one HTTP body the tracker sent through its own transport. */
  envelopes: number;
  /** Envelope items of type `transaction`. */
  transactions: number;
  /** Envelope items of type `event`. */
  events: number;
  /** Every request this sink did not accept: not a POST, not the envelope endpoint, or not an envelope. */
  rejected: number;
}

/**
 * Stand-in for the tracker's ingestion during the coexistence campaign (ESC-16): the process under test gets a
 * `SENTRY_DSN` pointing here, the tracker's own transport sends its own envelopes over its own serialisation,
 * and nothing leaves the machine, because the server binds `127.0.0.1` on a port that only this round knows.
 *
 * It counts what the tracker actually sent — envelopes, transactions, error events — so the report can prove
 * the tracker was live while its egress stayed local, the same contract `sink.ts` keeps for our batches. What
 * it is not: the tracker's ingestion. It answers `200 {}` and reads nothing else of the item, which is enough
 * to count and not enough to store — a sink that stored would be a second backend, on a benchmark.
 */
export class TrackerSink {
  readonly stats: TrackerSinkStats = { envelopes: 0, transactions: 0, events: 0, rejected: 0 };
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  private port = 0;

  /** The DSN a process under test is given: this server, and nothing this machine does not own. */
  get dsn(): string {
    return `http://publickey@127.0.0.1:${this.port}/${PROJECT_ID}`;
  }

  /**
   * The path the tracker's own transport builds from that DSN; anything else is not an envelope for us. In a
   * DSN, the last path element is the project id, not a URL prefix: the envelope goes to
   * `/api/<project id>/envelope/` (the pinned tracker's `getBaseApiEndpoint`, verified against its transport).
   */
  private get envelopePath(): string {
    return `/api/${PROJECT_ID}/envelope/`;
  }

  listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.dsn);
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
      // The tracker's transport builds `<dsn path>/api/<project id>/envelope/` from the DSN it was given. The
      // DSN is this sink's own, so the path is known: a request anywhere else is not an envelope for us.
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "", "http://127.0.0.1").pathname;
      } catch {
        pathname = "";
      }
      if (req.method !== "POST" || pathname !== this.envelopePath) {
        this.stats.rejected += 1;
        res.writeHead(404).end();
        return;
      }
      const items = envelopeItemTypes(Buffer.concat(chunks).toString("utf8"));
      if (items === undefined) {
        this.stats.rejected += 1;
        res.writeHead(400).end();
        return;
      }
      this.stats.envelopes += 1;
      for (const type of items) {
        if (type === "transaction") this.stats.transactions += 1;
        else if (type === "event") this.stats.events += 1;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  }
}

/** The project the DSN names. One, like the public key: this is a sink, not an organisation. */
const PROJECT_ID = "1";

/**
 * The item types of one envelope, or `undefined` when the body is not one.
 *
 * An envelope is its header line and then, per item, an item-header line and the payload. The item headers are
 * JSON and carry the `type`; the payloads of what this app's tracker sends are single-line JSON, so the lines
 * pair up. A body that breaks that shape is refused whole and counted as rejected: a sink that half-parsed an
 * envelope would count half a delivery.
 */
function envelopeItemTypes(body: string): string[] | undefined {
  const lines = body.split("\n");
  if (lines.length === 0 || parseHeader(lines[0]) === undefined) return undefined;
  const types: string[] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const header = parseHeader(lines[i]);
    if (header === undefined || typeof header.type !== "string") return undefined;
    types.push(header.type);
  }
  return types;
}

function parseHeader(line: string | undefined): Record<string, unknown> | undefined {
  if (line === undefined || line === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
