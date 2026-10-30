import path from "node:path";
import { performance } from "node:perf_hooks";
import { isAsyncFunction } from "node:util/types";
import { currentContext, recordCallIn, recordErrorIn, recordOperationIn } from "../context.ts";
import { applicationEntry, type From } from "../entry.ts";
import type { ErrorFingerprintCache } from "../errors.ts";
import { type Fingerprint, hash64 } from "../fingerprint.ts";
import type { Logger } from "../log.ts";
import { segmentLooksLikeValue } from "../sanitize.ts";
import { type Armed, armDriver } from "./arm.ts";

/**
 * MongoDB through its official driver, `mongodb`, and so through Mongoose, which sends every command through it
 * (ADR 0237): the commands a request sends, their time and their failures.
 *
 * Every command the driver sends goes through `Connection.prototype.command(ns, command, options)` in
 * `lib/cmap/connection.js`, the same in the 6.x and the 7.x drivers, and it is called in the context of the code that
 * asked: also when the pool made it wait for a connection, because the continuation is the awaiter's. That is the one
 * wrapper. It reads the first key of the command document, which is the command's name, and the collection it names,
 * and nothing else of it: the filter, the documents, the pipeline and the update hold the data (invariant 5).
 *
 * What it does not say, and why:
 *
 * - **The server.** A replica set's members — the primary, the secondaries a read goes to — are one database to the
 *   application, and every MongoDB command is the dependency `mongodb` with no target.
 * - **Two shapes of one command on one collection** apart: `find users` by email and by id are one operation. Their
 *   count per request, which is what a regression changes, is counted either way.
 * - **The wait for a connection.** The pool's queue is before this method, and is part of no command's time.
 */

const MARK = Symbol.for("downtrace.mongodb.instrumented");

/** The driver's own conversation on a new connection, and on closing: none of it is the request's. */
const PLUMBING = new Set(["hello", "isMaster", "ismaster", "saslStart", "saslContinue", "authenticate", "endSessions"]);

/** A command's name is a word: anything else is not one this observer can name, and is only counted. */
const COMMAND_NAME = /^[A-Za-z]{1,40}$/;
/** What a collection's name may be and still be written: the characters MongoDB's own tools write, no more. */
const COLLECTION_NAME = /^[A-Za-z0-9_.-]{1,120}$/;

interface Proto extends Record<string | symbol, unknown> {
  [MARK]?: boolean;
}

export interface InstrumentMongoDeps {
  log: Logger;
  /**
   * Where a failure of this observer's own code goes: the agent's count of internal errors, which logs it at debug,
   * sends the count in the batch and disables the instrumentation at the tenth (invariant 2, ADR 0161).
   */
  internalError: (err: unknown) => void;
  /** Where a thrown thing becomes a signature. Absent means errors are counted and not identified. */
  errors?: ErrorFingerprintCache | undefined;
}

/** How many distinct labels one process is expected to name. Beyond this they are made each time. */
const MAX_FINGERPRINTS = 1000;
const fingerprints = new Map<string, Fingerprint>();

/**
 * The operation a command is: its name and the collection it names, `find users`. Undefined when the name is not a
 * word, and then the command is counted against the dependency and is not an operation.
 */
export function mongoFingerprint(command: unknown): Fingerprint | undefined {
  const name = commandName(command);
  if (name === undefined || !COMMAND_NAME.test(name)) return undefined;
  const document = command as Record<string, unknown>;
  // `getMore` names its cursor first, and the collection beside it.
  const named = typeof document[name] === "string" ? document[name] : document.collection;
  const collection = typeof named === "string" ? collectionLabel(named) : undefined;
  const text = collection === undefined ? name : `${name} ${collection}`;
  const cached = fingerprints.get(text);
  if (cached !== undefined) return cached;
  const fingerprint: Fingerprint = { text, hash: hash64(`mongodb\0${text}`) };
  if (fingerprints.size < MAX_FINGERPRINTS) fingerprints.set(text, fingerprint);
  return fingerprint;
}

/** The first key of the command document, which is the command's name, or undefined for what is not one. */
function commandName(command: unknown): string | undefined {
  if (command === null || typeof command !== "object") return undefined;
  for (const key in command) return key;
  return undefined;
}

/**
 * A collection's name as it may travel: `?` when it looks like a value — a collection per customer, per day — or holds
 * what MongoDB's own tools would not write, so that such a collection is one operation and its name stays here.
 */
function collectionLabel(name: string): string {
  if (!COLLECTION_NAME.test(name)) return "?";
  return name.split(".").some((part) => part === "" || segmentLooksLikeValue(part)) ? "?" : name;
}

/**
 * Whether the server answered with a failure inside an `ok: 1`: write errors, or a write concern it could not meet. The
 * driver hands most replies over as BSON it reads on demand, which says what it holds through `has`.
 */
function failedInside(reply: unknown): boolean {
  if (reply === null || typeof reply !== "object") return false;
  const lazy = reply as { has?: unknown };
  if (typeof lazy.has === "function") {
    const has = lazy.has as (name: string) => unknown;
    return has.call(reply, "writeErrors") === true || has.call(reply, "writeConcernError") === true;
  }
  const { writeErrors, writeConcernError } = reply as { writeErrors?: unknown; writeConcernError?: unknown };
  return (
    (Array.isArray(writeErrors) && writeErrors.length > 0) ||
    (writeConcernError !== undefined && writeConcernError !== null)
  );
}

/**
 * Patches the `Connection` of the driver's `lib/cmap/connection.js`. Returns whether there was anything to patch. The
 * module is handed over already loaded: the production start-up does not load it (ADR 0209, `armMongo`), and a test
 * gives one.
 */
export function patchMongo(module: unknown, version: string, deps: InstrumentMongoDeps): boolean {
  const proto = (module as { Connection?: { prototype?: Proto } } | null | undefined)?.Connection?.prototype;
  if (!proto || typeof proto.command !== "function") {
    deps.log.debug("mongodb found but Connection.prototype.command is not a function; not instrumenting");
    return false;
  }
  if (proto[MARK] === true) return true;
  // A driver before 6 answers through a callback, from whichever request gave its pool a connection back: what a
  // wrapper would record is not known to be the request's, so it is not wrapped (ADR 0237).
  if (!isAsyncFunction(proto.command)) {
    deps.log.debug(`mongodb ${version} answers through callbacks; only 6 and later are instrumented`);
    return false;
  }
  const original = proto.command as (this: unknown, ...args: unknown[]) => unknown;
  proto.command = function (this: unknown, ...args: unknown[]): unknown {
    const ctx = currentContext();
    if (!ctx) return original.apply(this, args);
    let fingerprint: Fingerprint | undefined;
    try {
      const name = commandName(args[1]);
      if (name !== undefined && PLUMBING.has(name)) return original.apply(this, args);
      fingerprint = mongoFingerprint(args[1]);
    } catch (err) {
      deps.internalError(err);
      return original.apply(this, args);
    }
    const started = performance.now();
    const record = (failed: boolean, err?: unknown): void => {
      // Inside the driver's settling of the command, before the application's continuation: what is thrown here
      // would be the driver's to deal with. Measuring is not worth breaking what is measured.
      try {
        const ended = performance.now();
        recordCallIn(ctx, "mongodb", "", ended - started, failed);
        if (fingerprint !== undefined) {
          recordOperationIn(ctx, {
            kind: "query",
            fingerprint,
            startedAt: started,
            endedAt: ended,
            failed,
            target: "",
          });
          recordErrorIn(ctx, deps.errors, failed && err !== undefined, err, "", started, ended);
        }
      } catch (failure) {
        deps.internalError(failure);
      }
    };
    const result = original.apply(this, args);
    if (result !== null && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(
        (reply) => record(failedInside(reply)),
        (err: unknown) => record(true, err),
      );
    }
    return result;
  };
  proto[MARK] = true;
  deps.log.debug(`instrumented mongodb ${version}`);
  return true;
}

/** The driver's connection module, beside the entry its `require` resolves (`lib/index.js`). */
export function connectionModuleOf(resolved: string): string {
  return path.join(path.dirname(resolved), "cmap", "connection.js");
}

/**
 * The start-up half, as `pg`'s: resolve `mongodb` from the application's root, and from Mongoose's and MikroORM's,
 * which bring their own (DT-92), load nothing, and patch from the start of the first request at which the application
 * has loaded it (ADR 0209). The driver ships only CommonJS, so an `import` of it puts it in the module cache too.
 */
export function armMongo(deps: InstrumentMongoDeps & { from?: From | undefined }): Armed {
  return armDriver<unknown>({
    driver: "mongodb",
    from: deps.from ?? applicationEntry(),
    beside: ["mongoose", "@mikro-orm/mongodb"],
    log: deps.log,
    internalError: deps.internalError,
    patch: (_module, version, require, resolved) => {
      const file = connectionModuleOf(resolved);
      // Loaded with the driver; a driver laid out otherwise is one this observer does not know, and loads nothing.
      if (require.cache[file] === undefined) {
        deps.log.debug("mongodb loaded without lib/cmap/connection.js; not instrumenting");
        return;
      }
      patchMongo(require(file), version, deps);
    },
  });
}
