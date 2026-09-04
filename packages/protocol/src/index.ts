import schema from "../schema/v0/aggregates.schema.json" with { type: "json" };
import { LATENCY_BOUNDARIES_V0 } from "./generated/boundaries.ts";

/** Version of the ingestion protocol spoken by agents and the cloud. */
export const PROTOCOL_VERSION = "0.1.0";

/** Path, relative to the ingest URL, that receives AggregatesBatch payloads. */
export const AGGREGATES_PATH = "/v0/aggregates";

/** The JSON Schema (draft 2020-12) for AggregatesBatch, for validators on either side. */
export const AGGREGATES_SCHEMA_V0 = schema;

export type {
  AgentInfo,
  AggregatesBatch,
  DeployInfo,
  Endpoint,
  InstanceInfo,
  Interval,
  LatencyHistogram,
  StatusClasses,
} from "./generated/aggregates.ts";
export { LATENCY_BOUNDARIES_V0, LATENCY_BUCKETS_V0 } from "./generated/boundaries.ts";

/** Index of the bucket a latency (ms) falls into: first boundary >= latency, else the open-ended last bucket. */
export function latencyBucket(ms: number): number {
  const n = LATENCY_BOUNDARIES_V0.length;
  for (let i = 0; i < n; i++) {
    const bound = LATENCY_BOUNDARIES_V0[i];
    if (bound !== undefined && ms <= bound) return i;
  }
  return n;
}
