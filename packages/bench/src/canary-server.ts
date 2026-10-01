import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Regression } from "@downtrace/reference-app";
import type { CanaryConfig, CycleResult } from "./canary.ts";
import { EXPECTATIONS, regressionFor } from "./canary-expectations.ts";

/**
 * The canary's door, for whatever schedules it: `POST /cycle` with `{"regression": "<name>"}`, or `{}`
 * for tonight's (`regressionFor`), runs one cycle and answers its result when it is over, which can take the
 * detection and the recovery windows together: the caller waits that long. One cycle at a time: two regressions
 * at once would measure each other, so a second request while one runs is a 409 that names the running one.
 * `GET /healthz` says whether one is running.
 *
 * It is meant for an internal network only, beside the reference app whose `/__admin` it switches.
 */
export interface CanaryServerOptions {
  run: (regression: Regression) => Promise<CycleResult>;
  log: (line: string) => void;
  now: () => Date;
}

const MAX_BODY_BYTES = 1024;

export function createCanaryServer(options: CanaryServerOptions): Server {
  let running: Regression | null = null;
  const answer = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return answer(res, 200, { status: "ok", running });
    if (req.method !== "POST" || req.url !== "/cycle") return answer(res, 404, { error: "not found" });

    readBody(req).then(
      async (raw) => {
        const regression = regressionOf(raw, () => regressionFor(options.now()));
        if (regression === undefined) {
          return answer(res, 400, {
            error: `the body must be {"regression": one of ${Object.keys(EXPECTATIONS).join(", ")}}`,
          });
        }
        if (running !== null) return answer(res, 409, { error: "a cycle is running", running });
        running = regression;
        try {
          const result = await options.run(regression);
          options.log(JSON.stringify(result));
          answer(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          options.log(JSON.stringify({ regression, error: message }));
          answer(res, 500, { error: message });
        } finally {
          running = null;
        }
      },
      (err: unknown) => answer(res, 400, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`the body is over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function regressionOf(raw: string, tonight: () => Regression): Regression | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!("regression" in body)) return tonight();
  const name = (body as Record<string, unknown>).regression;
  return typeof name === "string" && Object.hasOwn(EXPECTATIONS, name) ? (name as Regression) : undefined;
}

/**
 * The canary's configuration, from the environment the entry point reads once. What cannot be defaulted —
 * where the reference app and the cloud are, the project and its credential — stops the start; a number that is not a
 * positive integer stops it too, rather than falling back to a default without a word.
 */
export function canaryConfigFrom(env: Readonly<Record<string, string | undefined>>): {
  port: number;
  cycle: CanaryConfig;
} {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const positive = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, not "${raw}"`);
    return n;
  };
  const url = (name: string) => required(name).replace(/\/+$/, "");
  return {
    port: positive("CANARY_PORT", 8080),
    cycle: {
      appUrl: url("CANARY_APP_URL"),
      cloudUrl: url("CANARY_CLOUD_URL"),
      project: required("CANARY_PROJECT"),
      token: required("CANARY_TOKEN"),
      pollMs: positive("CANARY_POLL_SECONDS", 60) * 1000,
      detectWithinMs: positive("CANARY_DETECT_WITHIN_MINUTES", 45) * 60_000,
      recoverWithinMs: positive("CANARY_RECOVER_WITHIN_MINUTES", 60) * 60_000,
      requestTimeoutMs: 20_000,
      freshWithinMs: 2 * 60_000,
    },
  };
}
