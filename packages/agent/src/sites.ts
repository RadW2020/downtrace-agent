import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type CallSite, currentContext, type OperationWork, operationKey, type RequestContext } from "./context.ts";
import { partsOf } from "./errors.ts";
import type { Logger } from "./log.ts";

/**
 * Where the application ran an operation, under `downtrace check` (RF-526): `src/users/users.service.ts:42`, so that a
 * coding agent reading a route that got worse goes to the line that runs the query, instead of searching the
 * repository for a text an ORM wrote.
 *
 * The stack is taken **when the application calls**, never when the operation ends: by then it holds the driver's
 * callbacks and nothing of the application. And only under `check`, which names the file (`DOWNTRACE_CHECK_SITES`) and
 * judges no time: production never builds this, and a driver given none takes nothing. Nothing of it is sent — it is
 * not the inspection file, which holds the batches as they would travel — and no place is a path of the machine: it is
 * relative to the project, and a frame outside the project, in `node_modules`, in Node or in this package is not one.
 *
 * Sampled, so the price is bounded: a request takes the stack of the first calls of each text it runs, and of no more
 * calls than a fixed number in all; a route keeps three places for each operation, and stops reading stacks once it has
 * them or has read enough of them to say it will not find more. Each process of a run appends what it found, one JSON
 * line per write, `{"sites":[{"route":"GET /users","kind":"query","hash":"…","at":"src/users.ts:42"}]}`, and `check`
 * folds them (`readSites`).
 */

/** How many places one operation of one route names. */
export const SITES_PER_OPERATION = 3;
/** How many calls of one text a request takes the stack of: a loop runs the same text from the same line. */
const SAMPLES_PER_TEXT = 3;
/** How many calls a request takes the stack of in all, whatever their texts. */
const SAMPLES_PER_REQUEST = 128;
/** How many frames a stack is taken with: past an ORM's, and past the awaits that lead to it. */
const STACK_FRAMES = 64;
/** How many stacks of one operation of one route are read looking for its places, before giving up on more. */
const READS_PER_OPERATION = 32;
/** How many operations of routes are kept, all routes together: a bound, as everything the instrumentation holds. */
const OPERATIONS = 4096;

/** This package's own directory: a frame in it is the instrumentation's, never the application's. */
const OWN = fileURLToPath(new URL("..", import.meta.url));

/** One place found, as it is written. The text only for what is not a query: a call's names its host (`identify`). */
interface Found {
  route: string;
  kind: OperationWork["kind"];
  hash: string;
  text?: string;
  at: string;
}

/** What one request took: how many stacks, of which texts, and the first ones of each operation. */
interface Sample {
  taken: number;
  texts: Map<string, number>;
  operations: Map<string, { kind: OperationWork["kind"]; hash: string; text: string; sites: Site[] }>;
}

/** One operation of one route, across the requests of this process: the places found, and the stacks read. */
interface Known {
  places: string[];
  read: number;
}

/** A call whose stack was taken, read only if its route still lacks a place for the operation it turned out to be. */
class Site implements CallSite {
  private readonly sites: CallSites;
  readonly frames: { stack?: unknown };

  constructor(sites: CallSites, frames: { stack?: unknown }) {
    this.sites = sites;
    this.frames = frames;
  }

  ran(ctx: RequestContext, operation: OperationWork): void {
    this.sites.ran(ctx, operation, this);
  }
}

/** What `within` runs under when the call was not sampled: what the driver runs inside it takes no stack either. */
const UNSAMPLED = Symbol("unsampled");

export class CallSites {
  private readonly file: string;
  private readonly project: string;
  private readonly log: Logger;
  private readonly requests = new WeakMap<RequestContext, Sample>();
  private readonly known = new Map<string, Known>();
  private readonly inside = new AsyncLocalStorage<Site | typeof UNSAMPLED>();
  private fresh: Found[] = [];
  private complained = false;

  constructor(spec: { file: string; project: string; log: Logger }) {
    this.file = spec.file;
    this.project = spec.project;
    this.log = spec.log;
  }

  /**
   * At the application's call: its stack, or nothing when the call is not sampled — outside a request, past the
   * request's samples or past those of `text`, what the driver was asked to run. Inside a call already taken
   * (`within`), that one: what a pool runs later, on a connection it hands over, was called there.
   */
  capture(text: string): Site | undefined {
    const outer = this.inside.getStore();
    if (outer !== undefined) return outer === UNSAMPLED ? undefined : outer;
    const ctx = currentContext();
    if (ctx === undefined) return undefined;
    const sample = this.sampleOf(ctx);
    const seen = sample.texts.get(text) ?? 0;
    if (sample.taken >= SAMPLES_PER_REQUEST || seen >= SAMPLES_PER_TEXT) return undefined;
    sample.taken += 1;
    sample.texts.set(text, seen + 1);
    const frames: { stack?: unknown } = {};
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = STACK_FRAMES;
    try {
      // Taken, not read: V8 writes the text of a stack when it is first read, which is `finished`'s to decide.
      Error.captureStackTrace(frames, this.capture);
    } finally {
      Error.stackTraceLimit = limit;
    }
    return new Site(this, frames);
  }

  /** Runs `call` as the call `site` was taken at, so that what the driver runs under it is charged to the same place. */
  within<T>(site: Site | undefined, call: () => T): T {
    return this.inside.run(site ?? UNSAMPLED, call);
  }

  /** The call `site` took turned out to be `operation`: kept among the first of it in the request. */
  ran(ctx: RequestContext, operation: OperationWork, site: Site): void {
    const sample = this.sampleOf(ctx);
    const key = operation.key ?? operationKey(operation.kind, operation.hash);
    let pending = sample.operations.get(key);
    if (pending === undefined) {
      pending = { kind: operation.kind, hash: operation.hash, text: operation.text, sites: [] };
      sample.operations.set(key, pending);
    }
    if (pending.sites.length < SITES_PER_OPERATION) pending.sites.push(site);
  }

  /** The request ended as `route` (`GET /users`): the stacks of its operations are read while the route lacks places. */
  finished(ctx: RequestContext, route: string): void {
    const sample = this.requests.get(ctx);
    if (sample === undefined) return;
    this.requests.delete(ctx);
    for (const [key, pending] of sample.operations) {
      const id = `${route}\n${key}`;
      let known = this.known.get(id);
      if (known === undefined) {
        if (this.known.size >= OPERATIONS) continue;
        known = { places: [], read: 0 };
        this.known.set(id, known);
      }
      for (const site of pending.sites) {
        if (known.places.length >= SITES_PER_OPERATION || known.read >= READS_PER_OPERATION) break;
        known.read += 1;
        const at = placeOf(site.frames, this.project);
        if (at === undefined || known.places.includes(at)) continue;
        known.places.push(at);
        const found: Found = { route, kind: pending.kind, hash: pending.hash, at };
        if (pending.kind !== "query" && pending.text !== "") found.text = pending.text;
        this.fresh.push(found);
      }
    }
  }

  /** Appends the places found since the last write. Never throws. */
  async write(): Promise<void> {
    const line = this.take();
    if (line === undefined) return;
    try {
      await appendFile(this.file, line);
    } catch (err) {
      this.complain(err);
    }
  }

  /** The same, blocking, for `process.on("exit")`, after which nothing asynchronous runs. Never throws. */
  writeOnExit(): void {
    const line = this.take();
    if (line === undefined) return;
    try {
      appendFileSync(this.file, line);
    } catch (err) {
      this.complain(err);
    }
  }

  private sampleOf(ctx: RequestContext): Sample {
    let sample = this.requests.get(ctx);
    if (sample === undefined) {
      sample = { taken: 0, texts: new Map(), operations: new Map() };
      this.requests.set(ctx, sample);
    }
    return sample;
  }

  private take(): string | undefined {
    if (this.fresh.length === 0) return undefined;
    const sites = this.fresh;
    this.fresh = [];
    return `${JSON.stringify({ sites })}\n`;
  }

  private complain(err: unknown): void {
    if (this.complained) return;
    this.complained = true;
    this.log.warn(
      `could not write the places of the operations to ${this.file}: ${err instanceof Error ? err.message : String(err)}` +
        "; check will not say where a route ran what got worse, and this is not said again",
    );
  }
}

/** Whether `file` is below `dir`. */
function below(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/**
 * The innermost frame of a taken stack that is the project's, as `file:line` relative to it, or nothing. Not one: a
 * frame outside the project, in a `node_modules`, in Node (`node:…`, which names no absolute file) or in this package.
 */
export function placeOf(frames: { stack?: unknown }, project: string): string | undefined {
  let stack: unknown;
  try {
    stack = frames.stack;
  } catch {
    // An application's `Error.prepareStackTrace` that throws writes no stack, and a call with no stack has no place.
    return undefined;
  }
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n")) {
    const where = partsOf(line)?.where;
    const at = where === undefined ? null : /^(.+):(\d+):\d+$/.exec(where);
    if (at?.[1] === undefined || at[2] === undefined) continue;
    let file = at[1];
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!isAbsolute(file) || below(OWN, file) || !below(project, file)) continue;
    const path = relative(project, file).split(sep);
    if (path.includes("node_modules")) continue;
    return `${path.join("/")}:${at[2]}`;
  }
  return undefined;
}
