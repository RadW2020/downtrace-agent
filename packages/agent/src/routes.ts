import type { Endpoint } from "@downtrace/protocol";
import { segmentLooksLikeValue } from "./sanitize.ts";

export type Method = Endpoint["method"];

export const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Longer than this and the template is truncated, so a label built from one has a worst case the arithmetic can use. */
export const MAX_ROUTE_LENGTH = 256;

/**
 * The longest label a register interns per route: its method, a space and the template — the longest method
 * (`normalizeMethod` allows the set above plus `OTHER`) and the longest template. The reserve arithmetic of
 * the tables that hold these labels is the arithmetic of this number (gh-765).
 */
export const MAX_ROUTE_LABEL_LENGTH = Math.max(...[...METHODS, "OTHER"].map((m) => m.length)) + 1 + MAX_ROUTE_LENGTH;

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
 * (`/products/:id` from Express); otherwise collapses a segment that carries a
 * value into `:id`, so that a parameter of the request does not leave (invariant 5, gh-756).
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

/**
 * The template a request's path becomes when no framework named it.
 *
 * A segment that is a value of any kind — an email, a token, a phone, a file name with a number — is `:id`
 * whole, decided by `segmentLooksLikeValue`, whose list and its discipline live in `src/sanitize.ts` (gh-756,
 * ADR 0167). What a value is not stays as written — a plain word, a slug, a version — and that is what the
 * README says: no rule of shape can tell a parameter from a route's own words, and the template the
 * developer writes is the lasting answer for one (`product.md:106`).
 *
 * The query and the fragment are cut before the path is read, because they are parameters and do not belong
 * in a template at all.
 */
export function heuristicTemplate(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? "/";
  const segments = path.split("/").map((s) => (s !== "" && segmentLooksLikeValue(s) ? ":id" : s));
  return trimSlash(segments.join("/") || "/");
}

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
