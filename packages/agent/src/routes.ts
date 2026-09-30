import type { Endpoint } from "@downtrace/protocol";
import { matchedMountOf, mountPathOf } from "./mounts.ts";
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

/** What we read off a request: Express sets `route`/`baseUrl`/`app`; plain Node gives us `url`. */
export interface RouteSource {
  url?: string | undefined;
  route?: unknown;
  baseUrl?: unknown;
  /** The Express app the request is being answered by, when there is one: the root of the mount walk. */
  app?: unknown;
  /**
   * The path the client asked for, as Express keeps it: not trimmed by the mounts, and not changed when the
   * request moves through them, so it can be read at the end of the response (gh-766).
   */
  originalUrl?: unknown;
}

/**
 * Route template for a request. Prefers the framework's own template
 * (`/products/:id` from Express), with the mounts that carried the request to the route as the patterns
 * they were registered with — never as the values they matched (invariant 5, gh-858); otherwise collapses
 * a segment that carries a value into `:id`, so that a parameter of the request does not leave
 * (invariant 5, gh-756).
 *
 * Without a template, the heuristic starts from the path the client asked for, `originalUrl`, when it is a
 * string: Express trims `url` as the request passes through the mounts, and a middleware that answers before
 * any route matched would lose the mount's prefix (gh-766). `originalUrl` is what the request was born with,
 * and it stays what it was whatever `next()` did, which is why it can be read at the end of the response,
 * where `baseUrl` plus `url` could not be.
 */
export function routeOf(req: RouteSource): string {
  const template = expressTemplate(req);
  const asked = typeof req.originalUrl === "string" ? req.originalUrl : (req.url ?? "/");
  const route = template ?? heuristicTemplate(asked);
  return route.length > MAX_ROUTE_LENGTH ? route.slice(0, MAX_ROUTE_LENGTH) : route;
}

/**
 * What a segment of the mount comes out as when it is known to carry a value and nothing more can be said
 * of it: the pattern could not be recovered with confidence, so the segment is a parameter and not a word
 * (invariant 5, gh-858). The README says when this happens.
 */
export const PARAM_SEGMENT = ":param";

function expressTemplate(req: RouteSource): string | undefined {
  const route = req.route;
  const path = (route as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string") return undefined;
  // The mount is read where the route matched it. When the dispatch of a matched route was recorded, its
  // `baseUrl` and `app` are the ones the request had while the route was dispatching, and not the values
  // the routers restore before the app's error handler answers (gh-900).
  const matched = route === undefined ? undefined : matchedMountOf(req);
  const rawBase = matched !== undefined ? matched.baseUrl : req.baseUrl;
  const base = typeof rawBase === "string" ? rawBase : "";
  const app = matched !== undefined ? matched.app : req.app;
  if (base === "") return path === "" ? "/" : trimSlash(path);
  // `base` is what the mounts matched, value for value; the template needs the pattern, which is recovered
  // from the routers the request went through. Whatever cannot be recovered with confidence comes out as
  // `:param` per segment (invariant 5, gh-858), never as a value.
  const links = mountLinks(app, route as object, base);
  return joinTemplate(links, path);
}

/** A router as the walk sees it: the layers, in registration order. Express calls it `stack`. */
interface RouterLike {
  stack: unknown[];
}

/** A layer as the walk reads it: what is stable across requests, and nothing else. */
interface LayerLike {
  route?: unknown;
  handle?: unknown;
  matchers?: unknown;
  regexp?: unknown;
  slash?: unknown;
}

/**
 * A mount that carried the request to the route. `value` is what it matched, to line the mounts up with
 * `baseUrl`; `pattern` is what it was registered with, or `undefined` when that cannot be said with
 * confidence — and then the value's segments come out as `:param`.
 */
interface MountLink {
  value: string;
  pattern: string | undefined;
}

const MAX_MOUNT_DEPTH = 16;

function isRouterLike(x: unknown): x is RouterLike {
  // A router is a function (the dispatch), carrying the layers as `stack`.
  return (
    x !== null && (typeof x === "object" || typeof x === "function") && Array.isArray((x as { stack?: unknown }).stack)
  );
}

function isLayerLike(x: unknown): x is LayerLike {
  return x !== null && typeof x === "object";
}

/**
 * The mounts that carried the request to the route's router, outermost first: what `baseUrl` is made of,
 * as patterns rather than values. The whole `baseUrl` comes back as one link without a pattern when the
 * mounts cannot be recovered with confidence, and `joinTemplate` then says `:param` for every segment.
 */
function mountLinks(app: unknown, route: object, base: string): MountLink[] {
  const anchor = anchorRouter(app);
  if (anchor === undefined) return base === "" ? [] : [{ value: base, pattern: undefined }];
  const apps = appChain(app);
  const direct = walkRouterLinks(anchor, route, base);
  if (direct !== undefined) {
    if (direct.length === 0) {
      // The anchor's own router holds the route, so nothing of `baseUrl` was matched under it: what is on
      // it is the mounts of the apps above, when Express recorded them, and `:param` when it did not.
      if (apps.length > 0 && cutFits(apps, base)) return appAsLinks(apps, base);
      return base === "" ? [] : [{ value: base, pattern: undefined }];
    }
    const tail = base.slice(direct.reduce((n, l) => n + l.value.length, 0));
    return tail === "" ? direct : [...direct, { value: tail, pattern: undefined }];
  }
  // The anchor's mounts could not be lined up against `baseUrl` as it stands — the usual reason is that
  // apps mounted above the anchor put their value in front of it, and that value is as long as its
  // parameters made it. Try the walk from each cut at a segment boundary, the smallest first.
  if (apps.length > 0) {
    for (const cut of cutCandidates(base)) {
      const fromCut = walkRouterLinks(anchor, route, base.slice(cut));
      if (fromCut !== undefined && cutFits(apps, base.slice(0, cut))) {
        const links = [...appAsLinks(apps, base.slice(0, cut)), ...fromCut];
        const tail = base.slice(cut + fromCut.reduce((n, l) => n + l.value.length, 0));
        return tail === "" ? links : [...links, { value: tail, pattern: undefined }];
      }
    }
  }
  return [{ value: base, pattern: undefined }];
}

/**
 * The router of the app the request is being answered by. Express keeps it on the app, and the app —
 * whichever one is answering, a mounted sub-app included — on the request.
 *
 * It is read, never called, and a read that throws is a read the walk cannot trust: in Express 4 the
 * router is on `_router` and `router` is a getter that throws, so `_router` goes first, and whatever a
 * read comes up as is what the walk has — `undefined` when it threw, and the `:param` fallback follows
 * (gh-898). This runs on the path of every request, and it does not throw because of the app (invariant 2).
 */
function anchorRouter(app: unknown): RouterLike | undefined {
  // An express app is a function (the dispatch), carrying its router as `router`.
  if (app === null || (typeof app !== "object" && typeof app !== "function")) return undefined;
  const candidate = app as { router?: unknown; _router?: unknown };
  const router = safeRead(() => candidate._router) ?? safeRead(() => candidate.router);
  return isRouterLike(router) ? router : undefined;
}

/** What a read of the application's object comes up as: `undefined` when it throws, and nothing else. */
function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The apps the request ended in, and the apps they are mounted in, outermost first, by the records
 * Express itself writes when one app is mounted under another: `mountpath` on the mounted app, `parent`
 * on it pointing at the one it is mounted in. A mount made the way Express does not record it — an app
 * under a router, or a path it does not keep as a string — comes out as `undefined`, and `:param` follows.
 */
function appChain(app: unknown): (string | undefined)[] {
  const chain: (string | undefined)[] = [];
  let current: unknown = app;
  const seen = new Set<object>();
  for (let depth = 0; depth < MAX_MOUNT_DEPTH; depth += 1) {
    // An app is a function (the dispatch), with `mountpath` and `parent` on it.
    if (current === null || (typeof current !== "object" && typeof current !== "function")) break;
    const a = current as { mountpath?: unknown; parent?: unknown };
    if (seen.has(a)) break;
    seen.add(a);
    // The records Express writes when one app is mounted under another, each read the walk cannot let
    // throw (gh-898).
    const parent = safeRead(() => a.parent);
    const mountpath = safeRead(() => a.mountpath);
    if (parent === null || (typeof parent !== "object" && typeof parent !== "function")) break; // the top app has no parent
    chain.push(typeof mountpath === "string" ? mountpath : undefined);
    current = parent;
  }
  return chain.reverse();
}

/**
 * The mounts between the anchor router and the route's router, outermost first, each with what it matched
 * and what it was registered with.
 *
 * It reads from what the routers keep from registration and nothing else: the layers' own compiled
 * matchers and regexps (the same ones the router used), the patterns `mounts.ts` recorded, and the object
 * graph of which router is mounted in which. The state the routers keep per request (`layer.path`,
 * `layer.params`) is not read: the next request that matches the same layer overwrites it, and by the
 * time a response finishes there may have been many — in Express 4 the value there is another tenant's
 * under interleaved requests (gh-898).
 *
 * `undefined` when the route cannot be reached from the anchor with the mounts lined up against
 * `remaining`: then nothing of them can be said with confidence, and that is what the caller falls back to.
 */
function walkRouterLinks(anchor: RouterLike, route: object, remaining: string): MountLink[] | undefined {
  const links: MountLink[] = [];
  let current = anchor;
  for (let depth = 0; depth < MAX_MOUNT_DEPTH; depth += 1) {
    if (directlyOwns(current, route)) return links;
    let descended = false;
    for (const layer of current.stack) {
      // Only mounts, in registration order: a route layer matches no prefix, and a middleware mount's
      // value is restored before the next layer matches, so neither is on `baseUrl` at the end.
      if (!isLayerLike(layer) || layer.route !== undefined) continue;
      const handle = layer.handle;
      if (!isRouterLike(handle)) continue;
      if (!ownsRoute(handle, route, 0)) continue;
      const matched = matchedValue(layer, remaining);
      if (matched === undefined) continue; // a double mount: this is not the one the request went through
      links.push({ value: matched.value, pattern: linkPattern(layer, matched.index) });
      remaining = remaining.slice(matched.value.length);
      current = handle;
      descended = true;
      break;
    }
    if (!descended) return undefined;
  }
  return undefined;
}

/** Whether the route's own layer is in this router, and not in a router mounted in it. */
function directlyOwns(router: RouterLike, route: object): boolean {
  return router.stack.some((layer) => isLayerLike(layer) && layer.route === route);
}

/** Whether the route is registered in this router, or in a router mounted in it. */
function ownsRoute(router: RouterLike, route: object, depth: number): boolean {
  if (depth > MAX_MOUNT_DEPTH) return false;
  for (const layer of router.stack) {
    if (!isLayerLike(layer)) continue;
    if (layer.route === route) return true;
    const handle = layer.handle;
    if (isRouterLike(handle) && ownsRoute(handle, route, depth + 1)) return true;
  }
  return false;
}

/**
 * What this mount matched of `path`, and which registered path it was, from the layer's own compiled
 * matchers — the same functions the router used, called rather than the router, because the router's
 * `match` writes per-request state onto a layer shared with every other request.
 */
function matchedValue(layer: LayerLike, path: string): { value: string; index: number } | undefined {
  if (layer.slash === true) return { value: "", index: 0 };
  const matchers = layer.matchers;
  if (Array.isArray(matchers)) {
    for (let i = 0; i < matchers.length; i += 1) {
      const matcher = matchers[i];
      if (typeof matcher !== "function") continue;
      let result: unknown;
      try {
        result = matcher(path);
      } catch {
        return undefined; // the router skips a matcher that throws; so does the walk
      }
      if (result !== null && typeof result === "object" && typeof (result as { path?: unknown }).path === "string") {
        return { value: (result as { path: string }).path, index: i };
      }
    }
    return undefined;
  }
  // Express 4 (router 1.x) keeps no matchers: the value is what the layer's own compiled regexp takes of
  // the path — the same one the router asked in its dispatch, called rather than the router because the
  // router's `match` writes the value onto a layer shared with every other request. It is compiled at
  // registration and stateless, which is why it can be asked twice; a stateful one would say something
  // different on each call and would make the walk change the application's state (gh-898). The value on
  // the layer, `path`, is never read: it is what the last request matched, not what the mount was
  // registered with.
  if (layer.regexp instanceof RegExp && !/[gy]/.test(layer.regexp.flags)) {
    let match: RegExpExecArray | null;
    try {
      match = layer.regexp.exec(path);
    } catch {
      return undefined; // the router skips a matcher that throws; so does the walk
    }
    if (match) return { value: match[0], index: 0 };
  }
  return undefined;
}

/**
 * What a mount comes out as in the template: the path it was registered with, as written.
 *
 * `undefined` is «cannot be said with confidence», and the caller folds the mount's value into `:param`
 * per segment (invariant 5): a layer registered before the record was armed or in a router it did not
 * reach, and a mount whose path is a regular expression, which has no words to be written back. The
 * record is the only source of the pattern: on the layer, `path` is a value in every Express — what the
 * last request matched, overwritten by the next one, another tenant's under interleaved requests — and
 * reading it for the pattern is the very leak this exists to close (invariant 5, gh-898).
 */
function linkPattern(layer: LayerLike, index: number): string | undefined {
  let raw: unknown = mountPathOf(layer);
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) raw = raw[index];
  if (typeof raw === "string") return raw;
  if (raw instanceof RegExp) return undefined;
  if (raw !== null && typeof raw === "object" && Array.isArray((raw as { tokens?: unknown }).tokens)) {
    // A parsed path (path-to-regexp's data) knows how to write itself back; take what it writes.
    try {
      const written = (raw as { toString(): unknown }).toString();
      return typeof written === "string" && written !== "" ? written : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether a cut leaving `prefix` behind can be the value of the app chain: each pattern segment needs one. */
function cutFits(app: (string | undefined)[], prefix: string): boolean {
  if (app.some((p) => p === undefined)) return true; // already folded into `:param`; the fit is not the question
  let need = 0;
  for (const pattern of app) if (typeof pattern === "string") need += pattern.split("/").filter((s) => s !== "").length;
  return prefix.split("/").filter((s) => s !== "").length >= need;
}

/** The cuts at a segment boundary of `base`, the smallest first: where an app's value may end. */
function cutCandidates(base: string): number[] {
  const cuts = new Set<number>([0]);
  for (let i = 0; i < base.length; i += 1) if (base[i] === "/") cuts.add(i + 1);
  return [...cuts].sort((a, b) => a - b);
}

/**
 * The app chain as links: its patterns, or — when a mount's pattern cannot be said — the value the chain
 * took of `baseUrl`, as one link without a pattern, so it comes out as `:param` per segment.
 */
function appAsLinks(app: (string | undefined)[], prefix: string): MountLink[] {
  if (app.some((p) => p === undefined)) return prefix === "" ? [] : [{ value: prefix, pattern: undefined }];
  return app.map((pattern) => ({ value: "", pattern }));
}

/**
 * The template the mounts and the route make: the patterns as written, outermost first, and a mount whose
 * pattern could not be recovered as `:param` per segment of what it matched — never a value (invariant 5,
 * gh-858).
 */
function joinTemplate(links: MountLink[], routePath: string): string {
  const parts: string[] = [];
  for (const link of links) {
    if (link.pattern !== undefined && link.pattern !== "" && link.pattern !== "/") {
      parts.push(link.pattern);
    } else if (link.pattern === undefined) {
      for (const segment of link.value.split("/")) if (segment !== "") parts.push(PARAM_SEGMENT);
    }
  }
  parts.push(routePath);
  let joined = parts
    .map((part, i) => (i > 0 && part !== "" && !part.startsWith("/") ? `/${part}` : part))
    .join("")
    .replace(/\/{2,}/g, "/");
  if (joined !== "" && !joined.startsWith("/")) joined = `/${joined}`;
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
