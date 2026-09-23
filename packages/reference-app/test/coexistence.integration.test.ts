import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ESC-16: the tracker Downtrace is meant to replace, loaded in the same process.
 *
 * covers: ERR-01, ERR-02
 *
 * «Each instrumentation observes what it would observe alone —requests, operations per request, errors— and
 * neither disables the other.» The only way to check that is to run the four configurations —each alone, and
 * both in each load order— against the same traffic, in real processes, and compare exact counts. The
 * baselines are in the same test on purpose: a fixture written by hand would be a copy of what somebody
 * remembered, and the question is what the other one actually sees.
 *
 * Downtrace's side is read through `DOWNTRACE_INSPECT`, which writes the serialised batch —byte for byte, the
 * one that would be sent— to a file (ADR 0033). No sink, no token, and above all no egress of ours to confuse
 * the comparison. The tracker's side is read through a **DSN pointing at a local HTTP server**: its real
 * transport, its real envelopes, nothing that leaves this machine.
 *
 * What this file does **not** claim is in `it("the tracker's own pg spans…")` below, and it is the reason
 * ESC-16 is still listed as not covered in `scripts/check-commitments.sh`.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// The same policy as `integration.test.ts`, and a local copy for the same reason: skipping without a database
// is right on a development machine and a silent pass in CI (gh-143).
if (!DATABASE_URL) {
  if (process.env.DOWNTRACE_REQUIRE_DB && process.env.GITHUB_ACTIONS) {
    throw new Error(
      "DATABASE_URL is not set, and in CI a test that cannot run is a failure: this job would have passed without " +
        "running the coexistence tests",
    );
  }
  console.warn("[reference-app] DATABASE_URL not set: skipping the coexistence tests (run `make dev`)");
}

const appDir = fileURLToPath(new URL("..", import.meta.url));
const DOWNTRACE = fileURLToPath(new URL("../../agent/src/register.ts", import.meta.url));
const TRACKER = "./src/sentry.ts";

/** How long anything here waits for something that should take milliseconds. */
const DEADLINE_MS = 30_000;

type Load = "downtrace" | "tracker";

/** One envelope item the tracker sent: its header type and its payload. */
interface Item {
  type: string;
  payload: Record<string, unknown>;
}

/** A local stand-in for the tracker's ingestion: a DSN points here, and the envelopes are read as they land. */
async function trackerSink() {
  const items: Item[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      // An envelope is a header line and then pairs of (item header, item payload), one JSON object per line.
      const lines = body.split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const header = parse(lines[i]);
        const payload = parse(lines[i + 1]);
        if (header && payload && typeof header.type === "string") items.push({ type: header.type, payload });
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    dsn: `http://publickey@127.0.0.1:${port}/1`,
    items,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parse(line: string | undefined): Record<string, unknown> | undefined {
  if (line === undefined || line === "") return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A line that is not JSON is not an envelope item; there is nothing to record and nothing to report.
    return undefined;
  }
}

/** What the traffic below produced, as each side saw it, plus what the application itself answered. */
interface Observed {
  /** The application's own truth: status codes it returned, in the order the traffic asked for them. */
  answers: number[];
  /** `GET /__admin/stats`: requests, queries, Redis operations and errors per endpoint, counted by the app. */
  stats: Record<string, Record<string, unknown>>;
  downtrace: DowntraceView | undefined;
  tracker: TrackerView | undefined;
}

/**
 * What one dependency did for one route: the histogram of **calls per request** —which is the shape of the
 * request, and the thing the ticket asks to be equal— and how many of those calls failed. The durations beside
 * them in the batch are left out: two processes never take the same number of milliseconds.
 */
interface DependencyCalls {
  callsPerRequest: number[];
  errors: number;
}

interface DowntraceView {
  /** `METHOD route` → what the batch says about it. */
  endpoints: Record<string, { count: number; errors: number; serverError: number; clientError: number }>;
  /** `METHOD route` → Postgres calls per request and failures charged to it. */
  postgres: Record<string, DependencyCalls>;
  /** `METHOD route` → Redis calls per request charged to it. */
  redis: Record<string, DependencyCalls>;
  /** `METHOD route` → outgoing HTTP calls per request charged to it, by target. */
  outgoing: Record<string, Record<string, DependencyCalls>>;
  /** `METHOD route` → operations of the profile by kind: `query`, `error`, `framework`, `explicit`. */
  operations: Record<string, Record<string, number>>;
  /** How many batches were written, and how many of them carried an `agent.resources` at all. */
  batches: number;
  reportedResources: number;
  /**
   * What the instrumentation said it cost itself. Inside `resources`, absent means zero and not «did not
   * say» (ADR 0093) — but that contract is only worth reading if `resources` itself is there, which is what
   * the two counters above are for: renaming the field would otherwise turn every assertion below into a
   * default, and the test would go on passing while measuring nothing.
   */
  internalErrors: number;
  shed: string | undefined;
}

interface TrackerView {
  /** Transaction name → how many the tracker sent. */
  transactions: Record<string, number>;
  /** Exception type → how many error events the tracker sent. */
  errors: Record<string, number>;
  /** Transaction name → the database spans inside it, by description. */
  dbSpans: Record<string, string[]>;
}

const running: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (running.length) await running.pop()?.();
});

/**
 * Starts the reference app in a process of its own with the instrumentations named, in the order named, drives
 * the traffic below and returns what each side saw.
 *
 * A real process, loaded with `--import` exactly as a user loads either of these, because what is being tested
 * is what happens when two of them patch the same prototypes — and that only happens for real.
 */
async function observe(load: Load[], options: { errorHandler?: "before" | "after" } = {}): Promise<Observed> {
  const dir = await mkdtemp(join(tmpdir(), "downtrace-coexistence-"));
  running.push(() => rm(dir, { recursive: true, force: true }));
  const inspectPath = join(dir, "batches.jsonl");
  const sink = load.includes("tracker") ? await trackerSink() : undefined;
  if (sink) running.push(sink.close);

  const imports = load.map((one) => (one === "downtrace" ? DOWNTRACE : TRACKER));
  const child = spawn(process.execPath, [...imports.flatMap((m) => ["--import", m]), "src/main.ts"], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: "0",
      PROVIDER_PORT: "0",
      DATABASE_URL: DATABASE_URL ?? "",
      REDIS_URL,
      APP_VERSION: "coexistence-1",
      REGRESSIONS: "",
      TRACKER_ERROR_HANDLER: options.errorHandler ?? "after",
      // No token and no URL: the instrumentation observes, aggregates and writes what it would send. With a
      // sink it would also be making HTTP calls of its own, inside this very process, and those would show up
      // in the comparison as traffic nobody asked for (ADR 0033).
      DOWNTRACE_INSPECT: load.includes("downtrace") ? inspectPath : "",
      DOWNTRACE_TOKEN: "",
      DOWNTRACE_URL: "",
      DOWNTRACE_INTERVAL_MS: "1000",
      SENTRY_DSN: sink?.dsn ?? "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
    }
  };
  running.push(stop);

  const listening = await new Promise<{ port: number; providerPort: number }>((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error(`the app never listened:\n${stdout}\n${stderr}`)), DEADLINE_MS);
    const look = () => {
      const ports = /"port":(\d+),"providerPort":(\d+)/.exec(stdout);
      if (!ports) return;
      clearTimeout(giveUp);
      resolve({ port: Number(ports[1]), providerPort: Number(ports[2]) });
    };
    child.stdout.on("data", look);
    child.on("exit", (code) => {
      clearTimeout(giveUp);
      reject(new Error(`the app exited with ${code} before listening:\n${stdout}\n${stderr}`));
    });
  });

  const base = `http://127.0.0.1:${listening.port}`;
  const answers = await drive(base);
  const stats = (await (await fetch(`${base}/__admin/stats`)).json()) as Record<string, Record<string, unknown>>;

  // The tracker sends as it goes; waiting for the count the traffic produced is what makes the comparison
  // exact rather than a race. A configuration that never gets there fails on the comparison, saying what
  // did arrive, which is more use than a sleep that hides it.
  if (sink) {
    const events = () => sink.items.filter((item) => item.type === "event").length;
    await settle(
      () =>
        `${EXPECTED_TRANSACTIONS} transactions for the application's routes (it sent ${productTransactions(sink.items)})`,
      () => productTransactions(sink.items) >= EXPECTED_TRANSACTIONS,
    );
    await settle(
      () => `${EXPECTED_EVENTS} error events (it sent ${events()})`,
      () => events() >= EXPECTED_EVENTS,
    );
  }
  await stop();

  // The ports are picked by the operating system, so a target is only comparable between two runs under a
  // name: the application's own provider, or the tracker's ingestion — which is the one worth watching, since
  // a tracker that sends from inside a request would have its egress charged to that request's route.
  const named: Record<string, string> = { [`127.0.0.1:${listening.providerPort}`]: "provider" };
  if (sink) named[`127.0.0.1:${sink.port}`] = "tracker";

  return {
    answers,
    stats,
    downtrace: load.includes("downtrace") ? await readBatches(inspectPath, named) : undefined,
    tracker: sink ? view(sink.items) : undefined,
  };
}

/**
 * How many transactions of the application's own routes the traffic below makes the tracker send.
 *
 * Eleven and not twelve, because the tracker drops the transaction of a 404 by default and one request here
 * gets one. Waiting for a number it will never reach is how a test turns a finding into a timeout.
 */
const EXPECTED_TRANSACTIONS = 11;
/** And how many error events: the failed query, the 502 the provider caused and the retry reported by hand. */
const EXPECTED_EVENTS = 3;

function productTransactions(items: Item[]): number {
  return items.filter((item) => item.type === "transaction" && isProductRoute(String(item.payload.transaction))).length;
}

/**
 * Whether a transaction name is one of the application's routes.
 *
 * The tracker also opens transactions for what the process does around the traffic —connecting to Redis at
 * start-up, quitting at shutdown— and one of those lands after the traffic is over. Comparing them would be
 * comparing the moment a run was stopped, not what either instrumentation observed.
 */
function isProductRoute(name: string): boolean {
  return name.includes("/") && !name.includes("/__admin");
}

/** The tracker's transactions for the application's own routes, which is what the traffic above produced. */
function routes(transactions: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(transactions ?? {}).filter(([name]) => isProductRoute(name)));
}

/**
 * Waits for what the traffic produced to arrive, and fails saying what did not.
 *
 * A wait that gave up quietly would turn «the tracker observed less» into «the test read it too early», which
 * is the difference between a finding and a flake.
 */
async function settle(what: () => string, done: () => boolean): Promise<void> {
  const until = Date.now() + DEADLINE_MS;
  while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!done()) throw new Error(`the tracker never sent ${what()} within ${DEADLINE_MS} ms`);
}

/**
 * The traffic every configuration runs, chosen so that every count it produces is the same every time.
 *
 * Nothing here depends on what a previous run left behind: the one cached read asks for a user that does not
 * exist, so it is a miss that writes nothing, and the checkout writes rows nobody reads back.
 *
 * **What comes back is the status code, and not the body.** Every body is read to completion and dropped,
 * because a response nobody drains holds its socket open and the next request waits on it — but nothing
 * compares them, and it is worth saying which claim that costs. A checkout answers with the `orderId` it
 * just inserted, which is a fresh value of a `bigserial` in every run, so «the same body» is false between
 * any two runs of this test whatever the instrumentation does. What is compared instead is the status codes
 * in order and the application's own counters, which is a narrower claim and a true one.
 */
async function drive(base: string): Promise<number[]> {
  const answers: number[] = [];
  const hit = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    await res.arrayBuffer();
    answers.push(res.status);
  };

  for (let i = 0; i < 3; i++) await hit("/products"); // 1 query each
  for (let i = 0; i < 2; i++) await hit("/products/1"); // 1 query each
  await hit("/me", { headers: { "x-user-id": "999999" } }); // 1 Redis miss, 1 query, 404
  // A query the database refuses: 2147483648 does not fit the `int` the column is. The failure is real, it is
  // inside a request, and Express turns it into a 500 — a failed operation and a framework error at once.
  await hit("/products/2147483648");
  await hit("/checkout", checkout()); // 12 queries, 2 provider calls, 3 Redis operations

  // And one the application handles itself: the provider refuses, the retry gives up, and the reference app
  // reports it to both instrumentations by name before letting the 502 out (ERR-02).
  await fetch(`${base}/__admin/provider`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failureRate: 1 }),
  });
  await hit("/checkout", checkout());
  await fetch(`${base}/__admin/provider`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failureRate: 0 }),
  });
  return answers;
}

function checkout(): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: 1, items: [{ productId: 1, quantity: 1 }] }),
  };
}

/** Everything the instrumentation wrote, folded into one view of what it observed. */
async function readBatches(path: string, named: Record<string, string>): Promise<DowntraceView> {
  const text = await readFile(path, "utf8");
  const batches = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const view: DowntraceView = {
    endpoints: {},
    postgres: {},
    redis: {},
    outgoing: {},
    operations: {},
    batches: batches.length,
    reportedResources: 0,
    internalErrors: 0,
    shed: undefined,
  };
  for (const batch of batches) {
    const agent = batch.agent as { resources?: { internalErrors?: number; shed?: string } };
    if (agent.resources !== undefined) view.reportedResources += 1;
    view.internalErrors += agent.resources?.internalErrors ?? 0;
    view.shed ??= agent.resources?.shed;
    for (const interval of (batch.intervals ?? []) as Record<string, unknown>[]) {
      for (const endpoint of (interval.endpoints ?? []) as Record<string, unknown>[]) {
        const key = `${endpoint.method as string} ${endpoint.route as string}`;
        const status = endpoint.status as { serverError?: number; clientError?: number };
        view.endpoints[key] ??= { count: 0, errors: 0, serverError: 0, clientError: 0 };
        const seen = view.endpoints[key];
        seen.count += endpoint.count as number;
        seen.errors += endpoint.errors as number;
        seen.serverError += status.serverError ?? 0;
        seen.clientError += status.clientError ?? 0;
        for (const dep of (endpoint.dependencies ?? []) as Record<string, unknown>[]) {
          if (dep.kind === "postgres") {
            view.postgres[key] ??= empty();
            add(view.postgres[key], dep);
          } else if (dep.kind === "redis") {
            view.redis[key] ??= empty();
            add(view.redis[key], dep);
          } else if (dep.kind === "http") {
            view.outgoing[key] ??= {};
            const byTarget = view.outgoing[key];
            const target = named[dep.target as string] ?? (dep.target as string);
            byTarget[target] ??= empty();
            add(byTarget[target], dep);
          }
        }
      }
    }
    const profile = batch.profile as { endpoints?: Record<string, unknown>[] } | undefined;
    for (const endpoint of profile?.endpoints ?? []) {
      const key = `${endpoint.method as string} ${endpoint.route as string}`;
      view.operations[key] ??= {};
      const byKind = view.operations[key];
      for (const operation of (endpoint.operations ?? []) as Record<string, unknown>[]) {
        const kind = operation.kind as string;
        byKind[kind] = (byKind[kind] ?? 0) + (operation.count as number);
      }
    }
  }
  return view;
}

/** A dependency nobody has counted yet. The histogram's length comes from the batch, never from a number here. */
function empty(): DependencyCalls {
  return { callsPerRequest: [], errors: 0 };
}

/** Adds one interval's worth of a dependency into the running total, bucket by bucket. */
function add(into: DependencyCalls, dep: Record<string, unknown>): void {
  const counts = dep.callsPerRequest as number[];
  if (into.callsPerRequest.length === 0) into.callsPerRequest = counts.map(() => 0);
  counts.forEach((n, i) => {
    into.callsPerRequest[i] = (into.callsPerRequest[i] ?? 0) + n;
  });
  into.errors += dep.errors as number;
}

/** Everything the tracker sent, folded the same way. */
function view(items: Item[]): TrackerView {
  const out: TrackerView = { transactions: {}, errors: {}, dbSpans: {} };
  for (const item of items) {
    if (item.type === "transaction") {
      const name = String(item.payload.transaction);
      out.transactions[name] = (out.transactions[name] ?? 0) + 1;
      const spans = (item.payload.spans ?? []) as Record<string, unknown>[];
      const db = spans.filter((span) => span.op === "db").map((span) => String(span.description));
      if (db.length > 0) {
        out.dbSpans[name] ??= [];
        out.dbSpans[name].push(...db);
      }
    }
    if (item.type === "event") {
      const values = (item.payload.exception as { values?: { type?: string }[] } | undefined)?.values ?? [];
      // An event carries the whole chain, oldest cause first, so the error that was actually reported is the
      // last one. Taking the first would name the cause of a `ProviderError` and call it an `Error`.
      const type = values.at(-1)?.type ?? "(no exception)";
      out.errors[type] = (out.errors[type] ?? 0) + 1;
    }
  }
  return out;
}

/** The routes of the application and of the provider it calls; `/__admin` is not product traffic (ADR 0021). */
function product(endpoints: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(endpoints).filter(([key]) => !key.includes("/__admin")));
}

/**
 * What the application counted, without what it timed.
 *
 * Two processes never take the same number of milliseconds, and a duration is not what this test is about:
 * comparing them would make it fail on a busy machine and say nothing about coexistence. What must be equal is
 * the work — requests, queries, calls, Redis operations, errors and status classes — and that is counted.
 */
const TIMED = new Set(["totalDurationMs", "poolWaitMs", "maxPoolWaitMs", "maxPoolWaitAt"]);
function counted(stats: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(product(stats) as Record<string, Record<string, unknown>>).map(([route, endpoint]) => [
      route,
      Object.fromEntries(Object.entries(endpoint).filter(([field]) => !TIMED.has(field))),
    ]),
  );
}

describe.skipIf(!DATABASE_URL)("@downtrace/agent beside @sentry/node, in one process", () => {
  it("each observes what it would observe alone, in either load order", async () => {
    const [alone, downtraceFirst, trackerFirst, trackerAlone] = await Promise.all([
      observe(["downtrace"]),
      observe(["downtrace", "tracker"]),
      observe(["tracker", "downtrace"]),
      observe(["tracker"]),
    ]);

    // Invariants 1 and 2 first: the same status codes in the same order in all four, and the work the
    // application says it did is the same work. Bodies are not in that claim, and `drive` says why.
    expect(downtraceFirst.answers).toEqual(alone.answers);
    expect(trackerFirst.answers).toEqual(alone.answers);
    expect(trackerAlone.answers).toEqual(alone.answers);
    expect(alone.answers).toEqual([200, 200, 200, 200, 200, 404, 500, 201, 502]);
    expect(counted(downtraceFirst.stats)).toEqual(counted(alone.stats));
    expect(counted(trackerFirst.stats)).toEqual(counted(alone.stats));
    expect(counted(trackerAlone.stats)).toEqual(counted(alone.stats));

    // Downtrace's side: requests, operations per request and errors, exactly the same with the tracker
    // loaded before it and after it as without it.
    const base = alone.downtrace;
    expect(base).toBeDefined();
    for (const [order, run] of [
      ["downtrace first", downtraceFirst],
      ["tracker first", trackerFirst],
    ] as const) {
      const seen = run.downtrace;
      expect(seen, order).toBeDefined();
      expect(product(seen?.endpoints ?? {}), order).toEqual(product(base?.endpoints ?? {}));
      expect(product(seen?.postgres ?? {}), order).toEqual(product(base?.postgres ?? {}));
      expect(product(seen?.redis ?? {}), order).toEqual(product(base?.redis ?? {}));
      expect(product(seen?.operations ?? {}), order).toEqual(product(base?.operations ?? {}));
      // Including the outgoing calls, under the names above: the tracker's own ingestion never shows up as a
      // dependency of a route. It sends outside the request that produced the error, so there is no request
      // to charge it to — and if that ever changed, a migration would start reading as a new dependency.
      expect(product(seen?.outgoing ?? {}), order).toEqual(product(base?.outgoing ?? {}));
      // What it says about itself, and first that it says anything at all. Inside `resources` an absent field
      // means zero (ADR 0093), so the two assertions below read a default when the field is missing and a
      // default when it is renamed — they would pass over an instrumentation that had stopped reporting. So
      // the batches are counted first, and every one of them has to carry its `resources`.
      expect(seen?.batches, order).toBeGreaterThan(0);
      expect(seen?.reportedResources, order).toBe(seen?.batches);
      // Invariant 2 from the inside: nothing of ours threw, whatever the other one did to the prototypes.
      expect(seen?.internalErrors, order).toBe(0);
      // And invariant 3's own half: the meter never had to give anything up to stay inside its budget.
      expect(seen?.shed, order).toBeUndefined();
    }
    // The baseline says it too, or «the same as the baseline» would be «as silent as the baseline».
    expect(base?.batches).toBeGreaterThan(0);
    expect(base?.reportedResources).toBe(base?.batches);
    expect(base?.internalErrors).toBe(0);
    expect(base?.shed).toBeUndefined();

    // What those counts are, written out once, so that a change to the traffic above cannot quietly become a
    // change to what «the same» means.
    expect(product(base?.endpoints ?? {})).toEqual({
      "GET /products": { count: 3, errors: 0, serverError: 0, clientError: 0 },
      "GET /products/:id": { count: 3, errors: 1, serverError: 1, clientError: 0 },
      "GET /me": { count: 1, errors: 0, serverError: 0, clientError: 1 },
      "POST /checkout": { count: 2, errors: 1, serverError: 1, clientError: 0 },
      // Twice: the second checkout is the one the provider refuses, and the provider is an HTTP server in
      // this same process, so its own 500 is traffic both instrumentations observe.
      "POST /authorize": { count: 2, errors: 1, serverError: 1, clientError: 0 },
      "POST /capture": { count: 1, errors: 0, serverError: 0, clientError: 0 },
    });
    expect(base?.operations["GET /products/:id"]).toEqual({ query: 3, error: 1, framework: 1 });
    expect(base?.operations["POST /checkout"]).toEqual({ query: 21, explicit: 1, framework: 1 });
    // And the shape of the request, which is what «queries per request» is: the two checkouts fall in two
    // different buckets of the histogram, because one ran the whole twelve and the other rolled back at nine.
    expect(base?.postgres["POST /checkout"]).toEqual({ callsPerRequest: [0, 0, 0, 0, 1, 1, 0, 0], errors: 0 });
    expect(base?.postgres["GET /products/:id"]).toEqual({ callsPerRequest: [0, 3, 0, 0, 0, 0, 0, 0], errors: 1 });
    expect(base?.redis).toEqual({
      "GET /me": { callsPerRequest: [0, 1, 0, 0, 0, 0, 0, 0], errors: 0 },
      "POST /checkout": { callsPerRequest: [0, 0, 0, 1, 0, 0, 0, 0], errors: 0 },
    });
    // The provider, and nothing else: the tracker's own ingestion is not in here, because it sends outside
    // the request that produced what it is sending.
    expect(base?.outgoing).toEqual({
      "POST /checkout": { provider: { callsPerRequest: [0, 1, 1, 0, 0, 0, 0, 0], errors: 1 } },
    });

    // The tracker's side: the transactions it sends and the errors it captures, exactly the same with
    // Downtrace loaded before it and after it as without it.
    const trackerBase = trackerAlone.tracker;
    // `GET /me` is not in this list and is in Downtrace's above: the tracker drops the transaction of a 404 by
    // default, and Downtrace counts every request. Two products answering two different questions, which is
    // what a migration compares — not something either one does to the other.
    expect(routes(trackerBase?.transactions)).toEqual({
      "GET /products": 3,
      "GET /products/:id": 3,
      "POST /checkout": 2,
      "POST /authorize": 2,
      "POST /capture": 1,
    });
    // The failed query, the 502 it made of the provider's refusal, and the one the application reported by
    // hand in the retry — the same three errors, told apart by the same names Downtrace uses.
    expect(trackerBase?.errors).toEqual({ error: 1, ProviderError: 1, Error: 1 });
    for (const [order, run] of [
      ["downtrace first", downtraceFirst],
      ["tracker first", trackerFirst],
    ] as const) {
      expect(routes(run.tracker?.transactions), order).toEqual(routes(trackerBase?.transactions));
      expect(run.tracker?.errors, order).toEqual(trackerBase?.errors);
    }
  }, 180_000);

  it("both error handlers see the framework's 5xx, whichever way round they are", async () => {
    const [after, before] = await Promise.all([
      observe(["downtrace", "tracker"], { errorHandler: "after" }),
      observe(["downtrace", "tracker"], { errorHandler: "before" }),
    ]);
    expect(before.answers).toEqual(after.answers);
    expect(before.tracker?.errors).toEqual(after.tracker?.errors);
    expect(product(before.downtrace?.operations ?? {})).toEqual(product(after.downtrace?.operations ?? {}));
    // Both of them, on the same error: ours as a `framework` operation of the profile, the tracker's as an
    // event. Neither answers the request, so the application's own handler still decides the response.
    expect(after.downtrace?.operations["GET /products/:id"]?.framework).toBe(1);
    expect(after.tracker?.errors.error).toBe(1);
  }, 180_000);

  /**
   * The half of ESC-16 that is **not** met, pinned so that meeting it turns this red.
   *
   * `instrumentPg` resolves `pg` from the application's root and requires it at start-up (ADR 0009): no loader
   * hooks, no dependency, works for an ESM application and a CommonJS one alike. `@sentry/node` instruments
   * `pg` the other way, by hooking module loading — and a module that is already in the cache is a module its
   * hook never sees. The two do not compose:
   *
   * - Downtrace loaded first: `pg-pool` is in the cache before the tracker's hooks exist, so its
   *   `Pool.prototype.connect` is never patched and **the tracker loses its connect span**. The query spans
   *   are right.
   * - The tracker loaded first: its hook fires on *our* `require("pg")` and again on the application's
   *   `import "pg"`, and our wrapper sitting on top of the first patch is not recognised as a wrapper, so
   *   nothing is unwrapped and **every query span is sent twice**.
   *
   * Downtrace observes the same thing either way — that is the test above — so what is broken is one half of
   * «each observes what it would observe alone», and it is ours to fix: nothing the tracker does would help.
   * gh-614 carries the fix; until it lands, the README says which order loses least and ESC-16 stays in
   * `NOT_YET_COVERED`.
   */
  it("the tracker's own pg spans do not survive our start-up require: the gap gh-614 fixes", async () => {
    const [alone, downtraceFirst, trackerFirst] = await Promise.all([
      observe(["tracker"]),
      observe(["downtrace", "tracker"]),
      observe(["tracker", "downtrace"]),
    ]);
    const spans = (run: Observed) => run.tracker?.dbSpans["GET /products"] ?? [];
    const query = "SELECT id, name, price_cents, stock FROM products ORDER BY id";

    // Alone: one connect span and one query span per request, three requests.
    expect(spans(alone).filter((d) => d === "pg-pool.connect")).toHaveLength(3);
    expect(spans(alone).filter((d) => d === query)).toHaveLength(3);
    // Downtrace first: the connect span is gone, the query spans are still one per request.
    expect(spans(downtraceFirst).filter((d) => d === "pg-pool.connect")).toHaveLength(0);
    expect(spans(downtraceFirst).filter((d) => d === query)).toHaveLength(3);
    // The tracker first: the connect span is back and every query span is duplicated.
    expect(spans(trackerFirst).filter((d) => d === "pg-pool.connect")).toHaveLength(3);
    expect(spans(trackerFirst).filter((d) => d === query)).toHaveLength(6);
  }, 180_000);
});

/**
 * The exception that kills the process, with both of them watching it.
 *
 * The tracker's `onUncaughtException` integration *handles* the exception and then ends the process itself —
 * which is exactly the shape ADR 0103 measured and refused for Downtrace, because a handled exception does not
 * kill the process. So how the process ends is the tracker's business here, and what invariant 2 asks of us is
 * narrower and checkable: **loading Downtrace changes nothing about it**, whichever side of the tracker it is
 * loaded on. Measured the way ADR 0103's own test measures, with real processes and real exit codes.
 */
describe("a process that dies with both of them loaded", () => {
  const THROWS = 'setTimeout(() => { throw new TypeError("boom in a timer"); }, 5);';

  async function ending(imports: string[]): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(
      process.execPath,
      [...imports.flatMap((m) => ["--import", m]), "--input-type=module", "-e", THROWS],
      {
        cwd: appDir,
        env: {
          ...process.env,
          // Neither of them can reach anything: what is being measured is how the process ends, and a send
          // that fails must not be what changes it.
          DOWNTRACE_URL: "http://127.0.0.1:1",
          DOWNTRACE_TOKEN: "t",
          DOWNTRACE_INSTRUMENT: "none",
          DOWNTRACE_INTERVAL_MS: "60000",
          DOWNTRACE_INSPECT: "",
          SENTRY_DSN: "http://publickey@127.0.0.1:1/1",
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    // The instrumentation's own debug lines are not the application's output.
    const ours = stderr
      .split("\n")
      .filter((line) => !line.startsWith("[downtrace]"))
      .join("\n");
    return { code, stderr: ours };
  }

  it("ends exactly as it would with the tracker alone, whichever order they were loaded in", async () => {
    const [tracker, downtraceFirst, trackerFirst] = await Promise.all([
      ending([TRACKER]),
      ending([DOWNTRACE, TRACKER]),
      ending([TRACKER, DOWNTRACE]),
    ]);
    expect(tracker.code, "the tracker ends the process itself, and it still ends non-zero").toBe(1);
    expect(downtraceFirst.code, "the exit code changed with Downtrace loaded, which is invariant 2").toBe(tracker.code);
    expect(trackerFirst.code, "the exit code changed with Downtrace loaded, which is invariant 2").toBe(tracker.code);
    // And the crash still says what it was. The trace is the tracker's rendering of it — with the tracker
    // loaded, Node's own source-line header is gone — but adding Downtrace does not take anything else away.
    expect(downtraceFirst.stderr).toBe(tracker.stderr);
    expect(trackerFirst.stderr).toBe(tracker.stderr);
    expect(tracker.stderr).toContain("TypeError: boom in a timer");
  }, 120_000);
});
