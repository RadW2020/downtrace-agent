import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { CALLS_PER_REQUEST_BUCKETS_V0 } from "@downtrace/protocol";
import { METHODS } from "../routes.ts";
import { declaredRoute } from "./config.ts";

/**
 * What a run left behind, read back: the file `DOWNTRACE_INSPECT` wrote, merged by route (LOC-01).
 *
 * The file is one JSON line per batch, and every process the run started writes into it — the runner, its
 * workers, the application when the tests start it as a child — so a route is not in one line, it is in many,
 * and a line says nothing about the others. This reads them all and folds them into one tally per route: how
 * many requests each route served, and what each request ran, by the fingerprint that names it.
 *
 * Everything in the file is `unknown` until it is read: it is written by another process, possibly cut in the
 * middle of a line by a runner that ended it, and a reader that trusted its shape would turn a torn line into a
 * crash. What cannot be read is counted and said (`malformed`), never skipped without a trace.
 *
 * `check` reads the files of its own runs with it, and `downtrace report` and `downtrace compare` read with it the
 * files a person hands them (`inspection.ts`): one reader, so that the three never count the same file two ways.
 */

/**
 * The kinds of dependency whose calls are queries: a database's. The other two are outgoing HTTP calls and Redis
 * commands.
 */
export const DATABASE_KINDS = ["postgres", "mysql", "sqlite", "mssql", "mongodb"] as const;

/**
 * The kinds of operation whose composition the comparison judges: what a route ran. The other three kinds of the
 * protocol are errors, and the comparison before the deploy is about composition (LOC-01), so they are not read.
 */
export const COMPOSITION_KINDS = ["query", "call", "command"] as const;
export type CompositionKind = (typeof COMPOSITION_KINDS)[number];

/** One operation of one route, summed over every process and every window the run wrote. */
export interface OperationTally {
  /** What two runs compare it by: the kind and the fingerprint, or the kind and the place for a loopback port. */
  id: string;
  kind: CompositionKind;
  /** The protocol's fingerprint. Absent when the comparison folds several of them into one (`identify`). */
  hash: string | undefined;
  /** What the operation is called, when the text travelled: `SELECT id FROM products WHERE id = ?`. */
  label: string | undefined;
  executions: number;
  totalMs: number;
}

/** One route of one run. */
export interface RouteTally {
  /** `POST /checkout`: the method, a space and the route template. Stable between runs, so it is the identity. */
  id: string;
  method: string;
  route: string;
  /** Every request the intervals counted. */
  requests: number;
  /**
   * The requests whose composition is known: the ones a profile window covers, and the ones that made no call to
   * any dependency, which have nothing a profile could have said. What an operation's executions are divided by.
   */
  profiledRequests: number;
  /** The requests that made calls and that no profile window covers: what a run that ended abruptly loses. */
  unprofiledRequests: number;
  /** Sum of the requests' durations, in milliseconds. Data: nothing is judged by it. */
  durationMs: number;
  operations: Map<string, OperationTally>;
  /**
   * How many of its requests ran how many queries, in the protocol's buckets of calls per request (0, 1, 2, 3 to 5, 6
   * to 10, 11 to 20, 21 to 50, more): what a median is read from, by `downtrace report`. From the intervals, so it
   * counts requests no profile covers too. Null when, in some interval, its requests reached more than one database:
   * each database has its own buckets, and how many queries one request ran in all is not in the file. Data: nothing
   * is judged by it.
   */
  queriesPerRequest: number[] | null;
}

export interface RunTally {
  /** Valid batches read. */
  batches: number;
  /** Distinct processes that wrote at least one batch. */
  processes: number;
  /** Lines and entries that could not be read. */
  malformed: number;
  /** Profile windows read, after the same window written twice is counted once. */
  profileWindows: number;
  requests: number;
  routes: Map<string, RouteTally>;
  /**
   * What the instrumentation said it observed, by driver: `on`, `off`, `unavailable`, or several joined by `/`. Said by
   * the processes that answered a request, when any did: a test runner's own process loads the instrumentation and no
   * application, and what it could not resolve is nothing the run lost.
   */
  observers: Record<string, string>;
}

/** `GET /products/:id`. Upper-case method, because the file carries it so and a configuration may not. */
export function routeId(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

// A call or a command to this machine. The port of a server a test starts on port 0 is different on every run,
// and it is part of the fingerprint's text, so left alone every such call would be an operation that appeared and
// another that vanished between two runs of the same code.
const LOOPBACK = /^([A-Za-z0-9_.:-]+) (localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/** How the comparison tells one operation from another: by fingerprint, but not by the port of this machine. */
export function identify(
  kind: CompositionKind,
  hash: string,
  text: string | undefined,
): { id: string; hash: string | undefined; label: string | undefined } {
  if (kind !== "query" && text !== undefined) {
    const match = LOOPBACK.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const place = `${match[1].toUpperCase()} ${match[2].toLowerCase()}`;
      return { id: `${kind}:${place}`, hash: undefined, label: `${place} (any port)` };
    }
  }
  return { id: `${kind}:${hash}`, hash, label: text };
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isInstant = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

interface RawOperation {
  kind: CompositionKind;
  hash: string;
  text: string | undefined;
  count: number;
  totalMs: number;
}
interface RawWindow {
  start: number;
  end: number;
  endpoints: Array<{ method: string; route: string; operations: RawOperation[] }>;
}
interface RawInterval {
  start: number;
  durationMs: number;
  endpoints: Array<{
    method: string;
    route: string;
    count: number;
    durationMs: number;
    calls: boolean;
    queries: number[] | null;
  }>;
}

function compositionKind(value: unknown): CompositionKind | undefined {
  return COMPOSITION_KINDS.find((kind) => kind === value);
}

/** Whether any request of the endpoint called a dependency: some bucket past «no calls» holds a request. */
function madeCalls(dependencies: unknown): boolean {
  if (!Array.isArray(dependencies)) return false;
  return dependencies.some((dependency) => {
    const buckets = isRecord(dependency) ? dependency.callsPerRequest : undefined;
    return Array.isArray(buckets) && buckets.some((n, i) => i > 0 && typeof n === "number" && n > 0);
  });
}

/** The buckets of calls per request, when they are the protocol's: as many as it has, and each a count. */
function bucketsOf(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.length === CALLS_PER_REQUEST_BUCKETS_V0 && value.every(isCount)
    ? [...value]
    : undefined;
}

/**
 * The requests of one endpoint of one interval by how many queries each ran, in the protocol's buckets; null when
 * they reached more than one database. A database's buckets count the requests that reached it, so the endpoint's
 * other requests ran none of its queries, and they are added to the first bucket. A database whose buckets cannot be
 * read is added to `problems`, and read as one more database: what it ran is not known.
 */
function queriesOf(count: number, endpoint: Rec, problems: { count: number }): number[] | null {
  const databases: number[][] = [];
  let unknown = false;
  for (const dependency of Array.isArray(endpoint.dependencies) ? endpoint.dependencies : []) {
    if (!isRecord(dependency) || !DATABASE_KINDS.some((kind) => kind === dependency.kind)) continue;
    const buckets = bucketsOf(dependency.callsPerRequest);
    if (buckets === undefined) {
      problems.count += 1;
      unknown = true;
    } else databases.push(buckets);
  }
  // Before protocol 0.4.0, Postgres's queries per request travelled in a field of their own.
  const legacy = isRecord(endpoint.postgres) ? bucketsOf(endpoint.postgres.queriesPerRequest) : undefined;
  if (databases.length === 0 && legacy !== undefined) databases.push(legacy);
  if (unknown || databases.length > 1) return null;
  const reached = databases[0]?.slice(1) ?? new Array<number>(CALLS_PER_REQUEST_BUCKETS_V0 - 1).fill(0);
  return [Math.max(0, count - reached.reduce((sum, n) => sum + n, 0)), ...reached];
}

/** Reads one profile window; the number of entries it could not read is added to `problems`. */
function readWindow(profile: Rec, problems: { count: number }): RawWindow | undefined {
  if (!isInstant(profile.start) || !isCount(profile.durationMs) || !Array.isArray(profile.endpoints)) {
    problems.count += 1;
    return undefined;
  }
  const endpoints: RawWindow["endpoints"] = [];
  for (const endpoint of profile.endpoints) {
    if (!isRecord(endpoint) || typeof endpoint.method !== "string" || typeof endpoint.route !== "string") {
      problems.count += 1;
      continue;
    }
    const operations: RawOperation[] = [];
    for (const operation of Array.isArray(endpoint.operations) ? endpoint.operations : []) {
      if (!isRecord(operation)) {
        problems.count += 1;
        continue;
      }
      const kind = compositionKind(operation.kind);
      // An error is not a composition: it is not malformed either, and it is not read.
      if (kind === undefined) continue;
      if (typeof operation.hash !== "string" || !isCount(operation.count) || !isCount(operation.totalMs)) {
        problems.count += 1;
        continue;
      }
      operations.push({
        kind,
        hash: operation.hash,
        text: typeof operation.text === "string" ? operation.text : undefined,
        count: operation.count,
        totalMs: operation.totalMs,
      });
    }
    endpoints.push({ method: endpoint.method, route: endpoint.route, operations });
  }
  return { start: profile.start, end: profile.start + profile.durationMs, endpoints };
}

function readInterval(interval: unknown, problems: { count: number }): RawInterval | undefined {
  if (!isRecord(interval) || !isInstant(interval.start) || !isCount(interval.durationMs)) {
    problems.count += 1;
    return undefined;
  }
  const endpoints: RawInterval["endpoints"] = [];
  for (const endpoint of Array.isArray(interval.endpoints) ? interval.endpoints : []) {
    if (
      !isRecord(endpoint) ||
      typeof endpoint.method !== "string" ||
      typeof endpoint.route !== "string" ||
      !isCount(endpoint.count)
    ) {
      problems.count += 1;
      continue;
    }
    const latency = isRecord(endpoint.latency) ? endpoint.latency.sum : undefined;
    endpoints.push({
      method: endpoint.method,
      route: endpoint.route,
      count: endpoint.count,
      durationMs: isCount(latency) ? latency : 0,
      calls: madeCalls(endpoint.dependencies),
      queries: queriesOf(endpoint.count, endpoint, problems),
    });
  }
  return { start: interval.start, durationMs: interval.durationMs, endpoints };
}

/**
 * How far from the edge of a window an interval's middle may fall and still be in it. The window and the interval
 * close on the same flush, a few milliseconds apart.
 */
const WINDOW_TOLERANCE_MS = 5;

function routeOf(routes: Map<string, RouteTally>, method: string, route: string): RouteTally {
  const id = routeId(method, route);
  let tally = routes.get(id);
  if (tally === undefined) {
    tally = {
      id,
      method: method.toUpperCase(),
      route,
      requests: 0,
      profiledRequests: 0,
      unprofiledRequests: 0,
      durationMs: 0,
      operations: new Map(),
      queriesPerRequest: new Array<number>(CALLS_PER_REQUEST_BUCKETS_V0).fill(0),
    };
    routes.set(id, tally);
  }
  return tally;
}

/** What is known of one process of the run: where its windows were and what its intervals counted. */
interface Owned {
  /** The instants its windows started at, to count one written twice once. */
  windows: Map<number, { start: number; end: number }>;
  intervals: Map<number, RawInterval>;
  /** What its instrumentation said it observed, by driver: every state it said. */
  observers: Map<string, Set<string>>;
}

/**
 * Folds the lines of an inspection file into one tally, a line at a time.
 *
 * Two things make the lines more than a sum. A write in flight when a process ends is written again by the exit,
 * so an interval or a window can be in the file twice: they are told apart by the process and the instant they
 * start at, and counted once, which keeps the absolute counts true and not only the ratios. And a request counts
 * toward what the profile says about its route only if a profile window of its process covers it, or if it made
 * no call to anything (then there was nothing for a profile to say): a run that ends the process before the
 * window closes would otherwise divide the executions it did record by requests it never recorded any for.
 *
 * The operations of a window are folded into their route as they are read — they are the heavy part, with their
 * text — and what is kept until the end is only where each window was and what each interval counted.
 */
export class RunReader {
  private readonly problems = { count: 0 };
  private readonly processes = new Map<string, Owned>();
  private readonly routes = new Map<string, RouteTally>();
  private batches = 0;

  add(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.problems.count += 1;
      return;
    }
    this.addBatch(value);
  }

  /**
   * One line, already parsed: for a reader that says which line it could not read (`inspection.ts`). Returns how
   * many things in it could not be read — the line itself, when it is not a batch, or entries of it — and 0 when all
   * of it was.
   */
  addBatch(value: unknown): number {
    const before = this.problems.count;
    this.read(value);
    return this.problems.count - before;
  }

  private read(value: unknown): void {
    const instance = isRecord(value) ? value.instance : undefined;
    if (!isRecord(value) || !isRecord(instance) || typeof instance.id !== "string") {
      this.problems.count += 1;
      return;
    }
    this.batches += 1;
    let owner = this.processes.get(instance.id);
    if (owner === undefined) {
      owner = { windows: new Map(), intervals: new Map(), observers: new Map() };
      this.processes.set(instance.id, owner);
    }
    const agent = isRecord(value.agent) ? value.agent : undefined;
    const observers = isRecord(agent?.observers) ? agent.observers : {};
    for (const [driver, state] of Object.entries(observers)) {
      if (typeof state !== "string") continue;
      const states = owner.observers.get(driver) ?? new Set<string>();
      states.add(state);
      owner.observers.set(driver, states);
    }
    if (isRecord(value.profile)) {
      const window = readWindow(value.profile, this.problems);
      if (window !== undefined && !owner.windows.has(window.start)) {
        owner.windows.set(window.start, { start: window.start, end: window.end });
        this.fold(window);
      }
    }
    for (const entry of Array.isArray(value.intervals) ? value.intervals : []) {
      const interval = readInterval(entry, this.problems);
      if (interval !== undefined && !owner.intervals.has(interval.start)) owner.intervals.set(interval.start, interval);
    }
  }

  private fold(window: RawWindow): void {
    for (const endpoint of window.endpoints) {
      const route = routeOf(this.routes, endpoint.method, endpoint.route);
      for (const operation of endpoint.operations) {
        const { id, hash, label } = identify(operation.kind, operation.hash, operation.text);
        const known = route.operations.get(id);
        if (known === undefined) {
          route.operations.set(id, {
            id,
            kind: operation.kind,
            hash,
            label,
            executions: operation.count,
            totalMs: operation.totalMs,
          });
        } else {
          known.executions += operation.count;
          known.totalMs += operation.totalMs;
        }
      }
    }
  }

  finish(): RunTally {
    let profileWindows = 0;
    let requests = 0;
    for (const owned of this.processes.values()) {
      const windows = [...owned.windows.values()];
      profileWindows += windows.length;
      for (const interval of owned.intervals.values()) {
        const middle = interval.start + interval.durationMs / 2;
        const covered = windows.some(
          (window) => middle >= window.start - WINDOW_TOLERANCE_MS && middle <= window.end + WINDOW_TOLERANCE_MS,
        );
        for (const endpoint of interval.endpoints) {
          const route = routeOf(this.routes, endpoint.method, endpoint.route);
          route.requests += endpoint.count;
          route.durationMs += endpoint.durationMs;
          requests += endpoint.count;
          if (covered || !endpoint.calls) route.profiledRequests += endpoint.count;
          else route.unprofiledRequests += endpoint.count;
          route.queriesPerRequest = addBuckets(route.queriesPerRequest, endpoint.queries);
        }
      }
    }
    return {
      batches: this.batches,
      processes: this.processes.size,
      malformed: this.problems.count,
      profileWindows,
      requests,
      routes: this.routes,
      observers: observersOf([...this.processes.values()]),
    };
  }
}

/** Two counts of queries per request, bucket by bucket; unknown when either is. */
function addBuckets(into: number[] | null, more: number[] | null): number[] | null {
  if (into === null || more === null) return null;
  return into.map((n, i) => n + (more[i] ?? 0));
}

/**
 * What the processes that answered a request said they observed, merged by driver; what every process said when none
 * answered one, so that a run in which nothing answered still says why its observers could not see.
 */
function observersOf(processes: readonly Owned[]): Record<string, string> {
  const answered = processes.filter((owned) =>
    [...owned.intervals.values()].some((interval) => interval.endpoints.some((endpoint) => endpoint.count > 0)),
  );
  const merged = new Map<string, Set<string>>();
  for (const owned of answered.length > 0 ? answered : processes) {
    for (const [driver, states] of owned.observers) {
      const into = merged.get(driver) ?? new Set<string>();
      for (const state of states) into.add(state);
      merged.set(driver, into);
    }
  }
  return Object.fromEntries([...merged].map(([driver, states]) => [driver, [...states].sort().join("/")]));
}

/** The lines of an inspection file, as text. */
export function readRun(text: string): RunTally {
  const reader = new RunReader();
  for (const line of text.split("\n")) reader.add(line);
  return reader.finish();
}

/**
 * The file a run wrote, read a line at a time: a long run of many processes writes a lot, and none of it is held
 * as text. A file that is not there is an empty run, and it is said as one by whoever asks.
 */
export async function readRunFile(path: string): Promise<RunTally> {
  const reader = new RunReader();
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
      reader.add(line);
    }
  } catch (err) {
    // A run that wrote nothing has no file.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  } finally {
    stream.destroy();
  }
  return reader.finish();
}

/** The routes the applications of a run declared, read back, and the lines and entries that could not be read. */
export interface DeclaredRead {
  routes: string[];
  malformed: number;
}

/**
 * Folds the file the instrumentation wrote the declared routes to (`DOWNTRACE_CHECK_ROUTES`) into one list, each
 * route once, sorted. Every process of the run appends to it, so a line can be cut by one that ended; what cannot
 * be read is counted, as in the batches, and a route is only taken in the shape the instrumentation writes it.
 */
export function readDeclared(text: string): DeclaredRead {
  const routes = new Set<string>();
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const listed = isRecord(value) ? value.routes : undefined;
    if (!Array.isArray(listed)) {
      malformed += 1;
      continue;
    }
    for (const entry of listed) {
      const route = typeof entry === "string" ? declaredRoute(entry) : undefined;
      if (route === undefined || !METHODS.has(route.slice(0, route.indexOf(" ")))) {
        malformed += 1;
        continue;
      }
      routes.add(route);
    }
  }
  return { routes: [...routes].sort(), malformed };
}

/** The same, from the file. A run in which no Express application answered a request leaves none: nothing declared. */
export async function readDeclaredFile(path: string): Promise<DeclaredRead> {
  try {
    return readDeclared(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { routes: [], malformed: 0 };
    throw err;
  }
}
