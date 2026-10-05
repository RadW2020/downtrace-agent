import {
  type AggregatesBatch,
  type Dependency,
  type Endpoint,
  type Interval,
  type Observers,
  type Operation,
  PROTOCOL_VERSION,
  type Profile,
  type ProfileEndpoint,
} from "@downtrace/protocol";

/**
 * The lines of an inspection file, built by hand and typed by the protocol: a batch that stops being valid when the
 * schema moves fails to compile here, and `check-read.test.ts` validates what these make against the schema itself.
 */

type Method = Endpoint["method"];

/** A latency histogram of `count` requests that took `meanMs` each: where the sum of their durations travels. */
function latency(count: number, meanMs: number): Endpoint["latency"] {
  const counts = new Array(35).fill(0) as Endpoint["latency"]["counts"];
  counts[10] = count;
  return { counts, sum: count * meanMs, max: meanMs };
}

/** What an endpoint of an interval says about its calls: `requestsWithCalls` of its `count` made one or more. */
function callsOf(kind: Dependency["kind"], count: number, requestsWithCalls: number): Dependency {
  const callsPerRequest: Dependency["callsPerRequest"] = [
    count - requestsWithCalls,
    requestsWithCalls,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  return { kind, target: "", callsPerRequest, totalMs: 0, max: 0, errors: 0 };
}

export function endpoint(
  method: Method,
  route: string,
  count: number,
  options: { meanMs?: number; requestsWithCalls?: number } = {},
): Endpoint {
  const withCalls = options.requestsWithCalls ?? 0;
  return {
    method,
    route,
    count,
    errors: 0,
    status: { success: count, redirect: 0, clientError: 0, serverError: 0 },
    latency: latency(count, options.meanMs ?? 5),
    ...(withCalls > 0 ? { dependencies: [callsOf("http", count, withCalls)] } : {}),
  };
}

export function interval(start: number, durationMs: number, endpoints: Endpoint[]): Interval {
  return { start, durationMs, endpoints };
}

export function operation(
  kind: Operation["kind"],
  hash: string,
  text: string | undefined,
  count: number,
  totalMs = count,
): Operation {
  return { kind, hash, ...(text === undefined ? {} : { text }), count, totalMs };
}

export function profileEndpoint(method: Method, route: string, operations: Operation[]): ProfileEndpoint {
  return { method, route, operations };
}

export function profile(start: number, durationMs: number, endpoints: ProfileEndpoint[]): Profile {
  return { start, durationMs, endpoints };
}

export function batch(
  process: string,
  parts: { intervals?: Interval[]; profile?: Profile; observers?: Observers },
): AggregatesBatch {
  return {
    protocol: PROTOCOL_VERSION,
    agent: {
      name: "@downtrace/agent",
      version: "0.0.0",
      runtime: "node",
      runtimeVersion: "24.0.0",
      ...(parts.observers === undefined ? {} : { observers: parts.observers }),
    },
    instance: { id: process, hostname: "test", pid: 1 },
    deploy: { version: "check", environment: "check" },
    intervals: (parts.intervals ?? []) as AggregatesBatch["intervals"],
    ...(parts.profile === undefined ? {} : { profile: parts.profile }),
  };
}

/** The text of an inspection file: one line per batch. */
export function fileOf(...batches: unknown[]): string {
  return batches.map((one) => JSON.stringify(one)).join("\n");
}
