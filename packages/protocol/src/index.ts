import schema from "../schema/v0/aggregates.schema.json" with { type: "json" };
import evidenceSchema from "../schema/v0/capture-evidence.schema.json" with { type: "json" };
import responseSchema from "../schema/v0/ingest-response.schema.json" with { type: "json" };
import { CALLS_PER_REQUEST_BOUNDARIES_V0, LATENCY_BOUNDARIES_V0 } from "./generated/boundaries.ts";

/** Path, relative to the ingest URL, that receives AggregatesBatch payloads. Generated from schema x-ingest-path. */
export { AGGREGATES_PATH, CAPTURE_EVIDENCE_PATH, captureEvidencePath } from "./generated/paths.ts";

/** The JSON Schema (draft 2020-12) for AggregatesBatch, for validators on either side. */
export const AGGREGATES_SCHEMA_V0 = schema;

/**
 * The JSON Schema for what the cloud answers. A contract since 0.8.0, when the answer started carrying the
 * captures the cloud is waiting for: an agent that ignores this body behaves exactly as it always did.
 */
export const INGEST_RESPONSE_SCHEMA_V0 = responseSchema;

/**
 * The JSON Schema for a capture's evidence: the black box's fine detail, frozen and sent back. Its own path
 * and its own contract, because a batch goes out every ten seconds and this is a rare event several orders of
 * magnitude larger.
 */
export const CAPTURE_EVIDENCE_SCHEMA_V0 = evidenceSchema;

export type {
  AgentInfo,
  AggregatesBatch,
  CaptureProgress,
  Dependency,
  DeployInfo,
  Endpoint,
  InstanceInfo,
  Interval,
  LatencyHistogram,
  LocalTrigger,
  ObserverState,
  Observers,
  Operation,
  PostgresStats,
  Profile,
  ProfileEndpoint,
  RuntimeHealth,
  StatusClasses,
} from "./generated/aggregates.ts";
export {
  CALLS_PER_REQUEST_BOUNDARIES_V0,
  CALLS_PER_REQUEST_BUCKETS_V0,
  LATENCY_BOUNDARIES_V0,
  LATENCY_BUCKETS_V0,
} from "./generated/boundaries.ts";
export type {
  CaptureCoverage,
  CapturedOperation,
  CapturedRequest,
  CaptureEvidence,
} from "./generated/capture-evidence.ts";
export type { IngestResponse, PendingCapture } from "./generated/ingest-response.ts";
/**
 * The protocol version this package speaks, and every minor of v0 ever published. Both are generated from the
 * schema's `protocol` enum, which is the only thing that decides what the cloud accepts: an agent on an older
 * minor keeps working because fields are only ever added, and always optional (ADR 0008).
 */
export { ACCEPTED_PROTOCOL_VERSIONS_V0, PROTOCOL_VERSION } from "./generated/versions.ts";

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
