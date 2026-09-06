import schema from "../schema/v0/aggregates.schema.json" with { type: "json" };
import { CALLS_PER_REQUEST_BOUNDARIES_V0, LATENCY_BOUNDARIES_V0 } from "./generated/boundaries.ts";

/**
 * Version of the ingestion protocol this package speaks. Every published minor of v0 stays acceptable to the
 * cloud, so an agent on an older minor keeps working: fields are only ever added, and always optional (ADR 0008).
 */
export const PROTOCOL_VERSION = "0.5.0";

/** Path, relative to the ingest URL, that receives AggregatesBatch payloads. */
export const AGGREGATES_PATH = "/v0/aggregates";

/** The JSON Schema (draft 2020-12) for AggregatesBatch, for validators on either side. */
export const AGGREGATES_SCHEMA_V0 = schema;

export type {
  AgentInfo,
  AggregatesBatch,
  Dependency,
  DeployInfo,
  Endpoint,
  InstanceInfo,
  Interval,
  LatencyHistogram,
  PostgresStats,
  RuntimeHealth,
  StatusClasses,
} from "./generated/aggregates.ts";
export {
  CALLS_PER_REQUEST_BOUNDARIES_V0,
  CALLS_PER_REQUEST_BUCKETS_V0,
  LATENCY_BOUNDARIES_V0,
  LATENCY_BUCKETS_V0,
} from "./generated/boundaries.ts";

/** Index of the bucket a latency (ms) falls into: first boundary >= latency, else the open-ended last bucket. */
export function latencyBucket(ms: number): number {
  const n = LATENCY_BOUNDARIES_V0.length;
  for (let i = 0; i < n; i++) {
    const bound = LATENCY_BOUNDARIES_V0[i];
    if (bound !== undefined && ms <= bound) return i;
  }
  return n;
}

/** Index of the bucket a call count falls into: first boundary >= count, else the open-ended last bucket. */
export function callsPerRequestBucket(calls: number): number {
  const n = CALLS_PER_REQUEST_BOUNDARIES_V0.length;
  for (let i = 0; i < n; i++) {
    const bound = CALLS_PER_REQUEST_BOUNDARIES_V0[i];
    if (bound !== undefined && calls <= bound) return i;
  }
  return n;
}
