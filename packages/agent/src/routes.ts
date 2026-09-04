import type { Endpoint } from "@downtrace/protocol";

export type Method = Endpoint["method"];

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_ROUTE_LENGTH = 256;

/** Route used when the per-interval cardinality cap is hit. */
export const OTHER_ROUTE = "(other)";

export function normalizeMethod(method: string | undefined): Method {
  const m = (method ?? "").toUpperCase();
  return METHODS.has(m) ? (m as Method) : "OTHER";
}

/** What we read off a request: Express sets `route`/`baseUrl`; plain Node gives us `url`. */
export interface RouteSource {
  url?: string | undefined;
  route?: unknown;
  baseUrl?: unknown;
}

/**
 * Route template for a request. Prefers the framework's own template
 * (`/products/:id` from Express); otherwise collapses identifier-looking path
 * segments (numbers, UUIDs, long hex) into `:id`.
 */
export function routeOf(req: RouteSource): string {
  const template = expressTemplate(req);
  const route = template ?? heuristicTemplate(req.url ?? "/");
  return route.length > MAX_ROUTE_LENGTH ? route.slice(0, MAX_ROUTE_LENGTH) : route;
}

function expressTemplate(req: RouteSource): string | undefined {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string") return undefined;
  const base = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const joined = `${base}${path}`.replace(/\/{2,}/g, "/");
  return joined === "" ? "/" : trimSlash(joined);
}

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{32,})$/i;

export function heuristicTemplate(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? "/";
  const segments = path
    .split("/")
    .map((s) => (s !== "" && (NUMERIC.test(s) || UUID.test(s) || HEX_ID.test(s)) ? ":id" : s));
  return trimSlash(segments.join("/") || "/");
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
