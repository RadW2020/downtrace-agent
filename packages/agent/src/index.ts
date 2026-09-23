export { Agent, type AgentDeps, type AgentStats, createAgent, type ReportedError } from "./agent.ts";
export { DEFAULT_MAX_ROUTES, IntervalAggregator, type Recorder } from "./aggregator.ts";
export {
  COARSE_MAX_BYTES,
  type CoarseCoverage,
  CoarseRegister,
  type CoarseRoute,
  type CoarseSecond,
  type CoarseSnapshot,
  DEFAULT_ROUTES,
  DEFAULT_SECONDS,
} from "./coarse.ts";
export { type AgentConfig, type ConfigResult, configFromEnv, DEFAULT_INTERVAL_MS, detectVersion } from "./config.ts";
export {
  DEFAULT_OPERATIONS,
  DEFAULT_OPERATIONS_PER_REQUEST,
  DEFAULT_REQUESTS,
  type FineCoverage,
  type FineOperation,
  FineRegister,
  type FineRequest,
  type FineSnapshot,
} from "./fine.ts";
export { createLogger, type Logger } from "./log.ts";
export { shutdown } from "./registered.ts";
// What an application calls itself (ERR-02). `captureException` takes the tracker's shape on purpose, so that
// replacing the import is the migration; `expressErrorHandler` is the one line the «no code» default needs
// for the exceptions a framework turns into a 5xx.
export {
  captureException,
  type ErrorRequestHandler,
  expressErrorHandler,
  MAX_CONTEXT_KEY_LENGTH,
  MAX_CONTEXT_KEYS,
  MAX_CONTEXT_VALUE_LENGTH,
  sanitizeContext,
} from "./report.ts";
export { heuristicTemplate, type Method, normalizeMethod, OTHER_ROUTE, routeOf } from "./routes.ts";
export { DEFAULT_MAX_QUEUED, Sender, type SenderOptions } from "./transport.ts";
export { AGENT_VERSION } from "./version.ts";
