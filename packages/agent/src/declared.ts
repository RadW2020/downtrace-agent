import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { fastifyInstanceOf } from "./fastify.ts";
import { honoRouterOf } from "./hono.ts";
import type { Logger } from "./log.ts";
import { matchedMountOf } from "./mounts.ts";
import { declaredRoutesOf } from "./routes.ts";

/**
 * The routes the Express, Fastify and Hono applications of this process declare, written for `downtrace check` (ESC-18).
 *
 * A route no test calls leaves nothing in the batches, so the comparison could only name it from a list the
 * user wrote by hand, and a coding agent that ran `init` and `check` had none: the routes it never reached were
 * not said at all, and «2 of 2 routes evaluated» read as everything. An application that answered a request
 * already says which routes it has, so the walk is made over each one that did.
 *
 * Only under `check`, which names the file (`DOWNTRACE_CHECK_ROUTES`): nothing of this is sent, and it is not
 * the inspection file, which holds the batches exactly as they would travel. Each write is one JSON line with
 * the routes not written before, `{"routes":["GET /health"]}`, appended, because every process of the run
 * writes into the same file: the runner, its workers, the application when the tests start it as a child.
 */
export interface DeclaredRoutes {
  /** A request finished: the Express applications that answered it are the ones whose routes are written. */
  answered(request: object): void;
  /** Appends the routes not written yet. Never throws. */
  write(): Promise<void>;
  /** The same, blocking, for `process.on("exit")`, after which nothing asynchronous runs. Never throws. */
  writeOnExit(): void;
}

export function createDeclaredRoutes(spec: {
  file: string | undefined;
  log: Logger;
  /** Whether a route template is observed at all: an excluded one is not, and is not declared either. */
  observed: (route: string) => boolean;
}): DeclaredRoutes | undefined {
  const { file, log, observed } = spec;
  if (file === undefined) return undefined;
  // Nothing here holds an application. A suite that builds one per test (a Nest app on a new Fastify, with its pool
  // and its modules) ran out of memory when each one that answered was kept for its routes (the stranger campaign).
  // So its routes are walked when it first answers and kept as names, and the application is held weakly, for what
  // it registers after that, for as long as something else holds it.
  const seen = new WeakSet<object>();
  const alive: Array<WeakRef<object>> = [];
  const walked = new Set<string>();
  const written = new Set<string>();
  let complained = false;
  const complain = (err: unknown): void => {
    if (complained) return;
    complained = true;
    log.warn(
      `could not write the declared routes to ${file}: ${err instanceof Error ? err.message : String(err)}` +
        "; check will not name the routes no test called, and this is not said again",
    );
  };
  // An Express app is a function (the dispatch), a Fastify instance an object. A mounted Express app answers inside
  // its parent, and the request carries the parent again by the time it finishes; the dispatch record keeps the one
  // the route was matched in.
  const remember = (app: unknown): void => {
    if ((typeof app !== "function" && (typeof app !== "object" || app === null)) || seen.has(app)) return;
    seen.add(app);
    alive.push(new WeakRef(app));
    for (const route of declaredRoutesOf(app)) walked.add(route);
  };
  const pending = (): string[] => {
    const routes = new Set(walked);
    for (let i = alive.length - 1; i >= 0; i--) {
      const app = alive[i]?.deref();
      if (app === undefined) alive.splice(i, 1);
      else for (const route of declaredRoutesOf(app)) routes.add(route);
    }
    const fresh: string[] = [];
    for (const route of routes) {
      if (written.has(route)) continue;
      const template = route.slice(route.indexOf(" ") + 1);
      if (observed(template)) fresh.push(route);
    }
    return fresh;
  };
  const line = (routes: string[]): string => `${JSON.stringify({ routes })}\n`;
  return {
    answered: (request) => {
      try {
        remember((request as { app?: unknown }).app);
        remember(matchedMountOf(request)?.app);
        remember(fastifyInstanceOf(request));
        remember(honoRouterOf(request));
      } catch {
        // A request whose `app` cannot be read is one whose routes are not walked (invariant 2).
      }
    },
    write: async () => {
      const fresh = pending();
      if (fresh.length === 0) return;
      try {
        await appendFile(file, line(fresh));
        for (const route of fresh) written.add(route);
      } catch (err) {
        complain(err);
      }
    },
    writeOnExit: () => {
      const fresh = pending();
      if (fresh.length === 0) return;
      try {
        appendFileSync(file, line(fresh));
        for (const route of fresh) written.add(route);
      } catch (err) {
        complain(err);
      }
    },
  };
}
