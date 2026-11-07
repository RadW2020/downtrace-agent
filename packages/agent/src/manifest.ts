import { readFile } from "node:fs/promises";
import path from "node:path";
import { basesOf, type From } from "./entry.ts";
import type { Logger } from "./log.ts";

/** The fields of a `package.json` that declare a dependency, as `init` and `check` read them. */
const DECLARING = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * The packages the application declares (RF-110): what tells a driver it declares and the instrumentation cannot
 * resolve — a bundle, a monorepo that keeps it elsewhere — from a database it does not use, which ADR 0240 could not.
 *
 * From each base, the closest `package.json` above it that declares any dependency: one that declares none, such as
 * the `{"type":"module"}` a build writes beside its files, is passed over. Never one inside `node_modules`: an entry
 * there is a dependency's — a CLI, a test runner under `check` — and its manifest lists what it was built and tested
 * with, not what the application uses; the application is the project above it. A manifest that cannot be read or is
 * not a JSON object ends the search from that base with nothing: what the application declares is then unknown, and
 * nothing above it is the application's to say.
 *
 * Asynchronous, and once, from the start (invariant 1). It never rejects: a read that fails or is cut short by `signal`
 * declares nothing, and says why in the debug log.
 */
export async function declaredDependencies(options: {
  from: From;
  signal: AbortSignal;
  log: Logger;
}): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  for (const base of basesOf(options.from)) {
    for (const name of await declaredFrom(base, options)) names.add(name);
  }
  return names;
}

async function declaredFrom(base: string, options: { signal: AbortSignal; log: Logger }): Promise<string[]> {
  // A base that ends in its separator is a directory to start inside (`applicationEntry`).
  let dir = base.endsWith(path.sep) ? path.resolve(base) : path.dirname(base);
  for (;;) {
    if (!dir.split(path.sep).includes("node_modules")) {
      const found = await manifestIn(path.join(dir, "package.json"), options);
      if (found !== "none") return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** What a `package.json` declares, or `none` when it is not there or declares nothing. */
async function manifestIn(file: string, options: { signal: AbortSignal; log: Logger }): Promise<string[] | "none"> {
  const unknownBecause = (why: string): string[] => {
    options.log.debug(`${file} ${why}; what the application declares is not known`);
    return [];
  };
  let text: string;
  try {
    text = await readFile(file, { encoding: "utf8", signal: options.signal });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "none";
    return unknownBecause(`could not be read (${err instanceof Error ? err.message : String(code)})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unknownBecause("is not JSON");
  }
  if (!isRecord(value)) return unknownBecause("is not a JSON object");
  if (!DECLARING.some((field) => field in value)) return "none";
  return DECLARING.flatMap((field) => {
    const listed = value[field];
    return isRecord(listed) ? Object.keys(listed) : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
