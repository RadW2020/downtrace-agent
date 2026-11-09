import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, type FileHandle, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./log.ts";

/**
 * The deployed version, when no variable names it (DT-130).
 *
 * The comparison of deploys is the core of the product, and it segments everything by this one string: without it
 * every batch says `unknown` and there is no deploy to compare. The variables come first (`VERSION_ENV_VARS`, read with
 * the rest of the configuration). On managed infrastructure there may be none, and no way to add one: the task's
 * environment and its start command belong to someone else. So the start-up looks further, from the most explicit
 * source to the most generic:
 *
 * 1. the commit `downtrace stamp` wrote into the build, where the build had git or a CI's variables (DT-223);
 * 2. the runtime's own metadata, where it exists with no configuration: on ECS, the digest of the container's image,
 *    from the task metadata endpoint;
 * 3. a fingerprint of the deployed code, which works anywhere.
 *
 * The stamp is a commit and travels as a variable's would, bare: the cloud and the MCP server read a version with no
 * prefix as the commit or the name a deploy was given, and one commit, stamped or named by a variable, is one deploy.
 * The other two are not commits, and each says what it is with a prefix on the value, `image:sha256:…` and `code:…`,
 * so that whoever reads it in the cloud or through the MCP server does not take it for one. A prefix and not a field
 * of its own: the protocol carries the version as a string, and what the string says of itself changes no contract.
 *
 * Kubernetes has no metadata of the kind with no configuration. The name of a Deployment's pod carries the hash of
 * its template, which changes when the template does, but `kubectl rollout restart` changes the template too, so a
 * restart would read as a deploy; and a StatefulSet's or a DaemonSet's pods carry none. The fingerprint covers it.
 */

/** A version and what chose it, which the line `DOWNTRACE_DEBUG` writes says. */
export interface Chosen {
  version: string;
  source: string;
}

/** What one source of the chain answered: a version, or why it has none. */
export type Answer = Chosen | { passed: string };

/** What a batch says when nothing named the version. */
export const UNKNOWN = "unknown";

/** Before the digest of a container image, which the runtime gave: `image:sha256:<64 hex>`. */
export const IMAGE_PREFIX = "image:";

/** Before a fingerprint of the deployed code: `code:<16 hex>`. */
export const CODE_PREFIX = "code:";

/** The file `downtrace stamp` writes into a build, with the commit the build was made from (DT-223). */
export const STAMP_FILE = ".downtrace-version";

/** What a commit looks like: git's object name, abbreviated or whole, in hexadecimal. */
export const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The most of a stamp that is read: a commit and its line ending, and room to spare. */
const STAMP_MAX_BYTES = 256;

/**
 * How long the whole search may take, from the start. The first batch waits for it, and never longer: past this, the
 * version is `unknown` for the life of the process. Generous on purpose: the search runs off the path of any request,
 * and the first batch leaves an interval after the start, ten seconds in production.
 */
export const VERSION_BUDGET_MS = 10_000;

/**
 * How long the ECS task metadata endpoint has to answer. It is the ECS agent, on the same host: milliseconds. Counted
 * on the event loop and not on the wall clock (`loopTimeout`).
 */
export const METADATA_TIMEOUT_MS = 1_000;

/**
 * The steps the endpoint's timeout is counted in (DT-223). The question is asked as the instrumentation starts, before
 * the application has loaded, and an application loads its modules in one synchronous stretch: seconds, on a small
 * Fargate task. A timer on the wall clock expired during that stretch and fired as soon as it ended, before the answer
 * that had come meanwhile was read, because the timers come first in a turn of the loop: the digest was lost on every
 * start longer than the timeout, and the fingerprint answered instead. Counted in steps, a stretch is one step however
 * long it is, and the endpoint has the loop's own time to answer in.
 */
const METADATA_STEP_MS = 100;

/** The most of its answer that is read: the container's metadata is a few kilobytes. */
const METADATA_MAX_BYTES = 64 * 1024;

/** The digest the task metadata gives as `ImageID`: the image manifest's. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * How much of the code the fingerprint reads, so its cost has a ceiling whatever the application is. Measured on n8n,
 * whose own package is 4,702 files and 17 MiB outside `node_modules`: 0.4 s of CPU, spread over the first seconds
 * and never holding the event loop for more than 2 ms. A file that no longer fits in `bytes` counts by its path and
 * its size; past `files`, the walk stops. Both cut at the same place on every instance of one build, because the walk
 * reads in one order: the fingerprint stays the same, and only a change past the cut goes unseen.
 */
export const FINGERPRINT_LIMITS: FingerprintLimits = { files: 5_000, bytes: 32 * 1024 * 1024 };

export interface FingerprintLimits {
  files: number;
  bytes: number;
}

/** Directories the fingerprint never enters: dependencies are not the application's code, nor is version control. */
const NOT_CODE = new Set(["node_modules", ".git", ".hg", ".svn"]);

/** The files it reads: code, as Node runs it or as it is compiled from. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** And the manifests that say which dependencies the code runs with. */
const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

const CHUNK_BYTES = 64 * 1024;

export interface LookOptions {
  /** `AgentConfig.ecsMetadataUri`. */
  ecsMetadataUri: string | undefined;
  /** The application's entry (`applicationEntry`), from which the code's root is found. */
  entry: string;
  fetchImpl: typeof fetch;
  /** The search's budget. Past it the fingerprint stops, and the search has found nothing. */
  signal: AbortSignal;
  /** Says what the user must know whether or not debug is on: a stamp that holds no commit, or cannot be read. */
  warn: (message: string) => void;
  /** Tests make these small; production leaves them alone. */
  metadataTimeoutMs?: number | undefined;
  limits?: FingerprintLimits | undefined;
}

/**
 * The chain past the variables: the stamped commit, then the image's digest on ECS, then a fingerprint of the code.
 * Never rejects: a source that fails is passed over, and what it said is kept for the debug line.
 */
export async function lookFurther(options: LookOptions): Promise<Chosen> {
  const passed: string[] = [];
  const stamped = await stampedCommit({ entry: options.entry, warn: options.warn });
  if (!("passed" in stamped)) return stamped;
  passed.push(stamped.passed);
  if (options.ecsMetadataUri !== undefined) {
    const answer = await imageDigest({
      uri: options.ecsMetadataUri,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS,
    });
    if (!("passed" in answer)) return answer;
    passed.push(answer.passed);
  }
  const answer = await codeFingerprint({ entry: options.entry, signal: options.signal, limits: options.limits });
  if ("passed" in answer) return { version: UNKNOWN, source: [...passed, answer.passed].join("; ") };
  return { ...answer, source: `${answer.source} (${passed.join("; ")})` };
}

/**
 * The commit `downtrace stamp` wrote: `.downtrace-version` in the code's root, the directory the fingerprint reads —
 * the closest above the entry with a `package.json`, where a package manager runs the `build` script that stamps — or
 * beside the entry when there is none, as for a bundle copied alone. One place, so a stamp elsewhere is not half read.
 *
 * Read once, at start-up, asynchronously and off the path of every request (invariant 1), and never thrown from: a
 * stamp that is not there is the common case and passes in silence, and one that cannot be read or holds no commit is
 * ignored with a warning, since someone meant it to be read. The warning names the file and not what it holds.
 */
export async function stampedCommit(options: { entry: string; warn: (message: string) => void }): Promise<Answer> {
  let file = STAMP_FILE;
  try {
    const root = await rootOf(options.entry);
    const dir = root === undefined ? path.resolve(options.entry) : "dir" in root ? root.dir : path.dirname(root.file);
    file = path.join(dir, STAMP_FILE);
    const bytes = await head(file, STAMP_MAX_BYTES + 1);
    const commit = bytes.toString("utf8").trim();
    if (bytes.length > STAMP_MAX_BYTES || !COMMIT.test(commit)) {
      const why = `${file} holds no commit (7 to 40 hexadecimal digits)`;
      options.warn(`${why}: it is ignored, and the version is looked for further`);
      return { passed: why };
    }
    return { version: commit.toLowerCase(), source: `${file}, which downtrace stamp wrote` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { passed: `no ${STAMP_FILE} in ${path.dirname(file)}` };
    const why = `${file} could not be read (${code ?? (err instanceof Error ? err.message : "a thrown value")})`;
    options.warn(`${why}: the version is looked for further`);
    return { passed: why };
  }
}

/** The first `max` bytes of a file, or all of it when it is shorter. */
async function head(file: string, max: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The digest of this container's image, from the ECS task metadata endpoint: `GET` on the URI the ECS agent set
 * answers with the metadata of the container that asks, and its `ImageID` is «the SHA-256 digest of the image
 * manifest». The same on every task of one deploy, and a new one with every image.
 *
 * External input, so `unknown` until checked: an answer that is not a 2xx, not JSON, too long, or with no digest of
 * the right shape is passed over, and so is one that does not come within `timeoutMs`.
 */
export async function imageDigest(options: {
  uri: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<Answer> {
  const source = "the ECS task metadata";
  const timeout = loopTimeout(options.timeoutMs);
  try {
    const res = await options.fetchImpl(options.uri, { signal: timeout.signal });
    if (!res.ok) {
      // The body of a refusal is not read, only let go of.
      await res.body?.cancel();
      return { passed: `${source} answered ${res.status}` };
    }
    const text = await bodyWithin(res, METADATA_MAX_BYTES);
    if (text === undefined) return { passed: `${source} answered more than ${METADATA_MAX_BYTES} bytes` };
    const digest = imageIdOf(text);
    if (digest === undefined) return { passed: `${source} named no image digest` };
    return { version: `${IMAGE_PREFIX}${digest}`, source };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { passed: `${source} did not answer within ${options.timeoutMs} ms` };
    }
    return { passed: `${source} could not be read: ${err instanceof Error ? err.message : "a thrown value"}` };
  } finally {
    timeout.clear();
  }
}

/**
 * A signal that aborts once `ms` of the event loop's own time have passed, in steps of `METADATA_STEP_MS`: a step is a
 * timer that starts the next when it fires, so a synchronous stretch of any length delays one step and is not counted.
 * Unreferenced, as `AbortSignal.timeout`'s timer is, so it never keeps a process alive. `clear` stops it.
 */
function loopTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const steps = Math.max(1, Math.ceil(ms / METADATA_STEP_MS));
  const step = ms / steps;
  let left = steps;
  const tick = (): void => {
    left -= 1;
    if (left > 0) timer = setTimeout(tick, step).unref();
    else controller.abort(new DOMException(`no answer within ${ms} ms`, "TimeoutError"));
  };
  let timer = setTimeout(tick, step).unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** The `ImageID` of the container's metadata, when the text is JSON and the field a digest; undefined otherwise. */
function imageIdOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: an answer with no digest in it, which is what the caller says.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const id: unknown = (parsed as Record<string, unknown>).ImageID;
  return typeof id === "string" && IMAGE_DIGEST.test(id) ? id : undefined;
}

/** The body as text, or undefined once it passes `max` bytes, at which point the rest is not read. */
async function bodyWithin(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A fingerprint of the deployed code: a hash of its content, which changes when the code does and stays the same
 * across restarts and across the instances of one build. The content and not the times: a checkout in CI gives every
 * file a new time with every build, and two instances of one image may not agree on them either.
 *
 * What it reads:
 *
 * - **the root**: the closest directory above the entry with a `package.json`. Without one, or when that is the root
 *   of the file system, the entry alone: a walk of `/` is a walk of the whole machine;
 * - **the files**: code (`.js`, `.ts` and their kin) and the manifests and lockfiles, by their path from the root, so
 *   where the build is unpacked does not matter. Neither `node_modules` nor version control, nor any other file:
 *   logs, uploads and data are written by the running application and would change the fingerprint with a restart;
 * - **in one order**: the files of a directory, sorted by name, before its subdirectories, so the manifests at the
 *   root are always read, and up to `FINGERPRINT_LIMITS`.
 *
 * Asynchronous, one file at a time, through one buffer: nothing in it holds the event loop, and the memory it uses
 * does not grow with the application. What cannot be read — a directory or a file the process has no permission
 * for, one that went away during the walk — is left out, the same on every instance of one image.
 */
export async function codeFingerprint(options: {
  entry: string;
  signal: AbortSignal;
  limits?: FingerprintLimits | undefined;
}): Promise<Answer> {
  try {
    const root = await rootOf(options.entry);
    if (root === undefined) return { passed: `no code to fingerprint: no package.json above ${options.entry}` };
    const walk = new Walk(options.signal, options.limits ?? FINGERPRINT_LIMITS);
    if ("file" in root) await walk.file(root.file, path.basename(root.file));
    else await walk.directory(root.dir, "", { top: true });
    const under = "file" in root ? root.file : root.dir;
    if (walk.files === 0) return { passed: `no code to fingerprint under ${under}` };
    const cut = walk.stopped ? `, the first ${walk.files} in the order they are read` : "";
    return {
      version: `${CODE_PREFIX}${walk.hash.digest("hex").slice(0, 16)}`,
      source: `a fingerprint of ${walk.files} files under ${under}${cut}`,
    };
  } catch (err) {
    if (options.signal.aborted) return { passed: "the fingerprint did not finish within its budget" };
    return { passed: `the code could not be fingerprinted: ${err instanceof Error ? err.message : "a thrown value"}` };
  }
}

/** Where the fingerprint reads from: a directory, or the entry alone. */
async function rootOf(entry: string): Promise<{ dir: string } | { file: string } | undefined> {
  const isDirectory = entry.endsWith(path.sep);
  let dir = isDirectory ? path.resolve(entry) : path.dirname(entry);
  for (;;) {
    if (await exists(path.join(dir, "package.json"))) {
      if (dir !== path.parse(dir).root) return { dir };
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return isDirectory ? undefined : { file: entry };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    // Absent, or not ours to read: either way not a root to read from.
    return false;
  }
}

/** One walk of the code, into one hash. */
class Walk {
  readonly hash = createHash("sha256");
  files = 0;
  /** Whether the walk stopped at `limits.files` before it had read everything. */
  stopped = false;
  private bytes = 0;
  private readonly buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  private readonly signal: AbortSignal;
  private readonly limits: FingerprintLimits;

  constructor(signal: AbortSignal, limits: FingerprintLimits) {
    this.signal = signal;
    this.limits = limits;
  }

  /**
   * The files of `dir`, then its subdirectories. The root's listing has to succeed, or there is no fingerprint: a
   * hash of nothing is the same for every build. Below it, a directory that cannot be listed is left out.
   */
  async directory(dir: string, relative: string, options: { top: boolean }): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (options.top) throw err;
      return;
    }
    // By code unit and not by locale: the order is part of the fingerprint, and a locale is a setting of the machine.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const at = (name: string): string => (relative === "" ? name : `${relative}/${name}`);
    // A symbolic link is neither a file nor a directory here, and is not followed: it may lead out of the root, or
    // back into it.
    for (const entry of entries) {
      if (!entry.isFile() || !(CODE_FILE.test(entry.name) || MANIFESTS.has(entry.name))) continue;
      if (this.files >= this.limits.files) {
        this.stopped = true;
        return;
      }
      await this.file(path.join(dir, entry.name), at(entry.name));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_CODE.has(entry.name)) continue;
      await this.directory(path.join(dir, entry.name), at(entry.name), { top: false });
      if (this.stopped) return;
    }
  }

  /** One file: its path, its size and, while it fits in `limits.bytes`, its content. */
  async file(absolute: string, relative: string): Promise<void> {
    this.signal.throwIfAborted();
    let handle: FileHandle;
    try {
      handle = await open(absolute, "r");
    } catch {
      // Not ours to read, or gone since the listing: left out, as on every instance of the same image.
      return;
    }
    try {
      const { size } = await handle.stat();
      const whole = this.bytes + size <= this.limits.bytes;
      this.hash.update(`${relative}\0${size}\0${whole ? "content" : "size"}\0`);
      this.files += 1;
      if (!whole) return;
      // Up to the size it had when it was opened: a file that grows meanwhile does not change what is read.
      let position = 0;
      while (position < size) {
        this.signal.throwIfAborted();
        const { bytesRead } = await handle.read(this.buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
        if (bytesRead === 0) break;
        this.hash.update(this.buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      this.bytes += size;
    } finally {
      await handle.close();
    }
  }
}

/**
 * One version for the life of the process (DT-130).
 *
 * Every batch reads it, and the first read fixes it: a version that a batch has said is never replaced. A search that
 * answers after that is too late, and its answer is dropped, because a process that said `unknown` and then a digest
 * would read as two deploys. So the first batch waits for the search, within its budget (`ready`), and the reads that
 * cannot wait — the writes on the way out of a process that called `process.exit()` — take what is known.
 *
 * The choice is said once, with `DOWNTRACE_DEBUG`: which source chose the version, or why none did.
 */
export class DeployedVersion {
  private chosen: Chosen | undefined;
  private settled: Promise<void> = Promise.resolve();
  private readonly log: Logger;

  constructor(options: { log: Logger }) {
    this.log = options.log;
  }

  /** Whether the version is still open: nothing named it, and no batch has read it yet. */
  get open(): boolean {
    return this.chosen === undefined;
  }

  /** A variable or the configuration named it: chosen now. */
  named(chosen: Chosen): void {
    this.choose(chosen);
  }

  /**
   * Nothing named it: look further, for at most `budgetMs`. Returns at once; nothing of the search runs in the caller,
   * and nothing it throws reaches it.
   */
  search(look: (signal: AbortSignal) => Promise<Chosen>, budgetMs: number): void {
    if (this.chosen !== undefined) return;
    const budget = AbortSignal.timeout(budgetMs);
    let looked: Promise<Chosen>;
    try {
      looked = look(budget);
    } catch (err) {
      looked = Promise.reject(err);
    }
    let over = (): void => {};
    const late = new Promise<Chosen>((resolve) => {
      over = () => resolve({ version: UNKNOWN, source: `no source answered within ${budgetMs} ms` });
      budget.addEventListener("abort", over, { once: true });
    });
    const failed = (err: unknown): Chosen => ({
      version: UNKNOWN,
      source: `the search failed: ${err instanceof Error ? err.message : "a thrown value"}`,
    });
    this.settled = Promise.race([looked.catch(failed), late]).then((chosen) => {
      budget.removeEventListener("abort", over);
      this.choose(chosen);
    });
  }

  /**
   * Resolves once the version is chosen, or once the search's budget has passed, or once `deadline` has, whichever is
   * first. Never rejects.
   */
  async ready(deadline?: AbortSignal): Promise<void> {
    if (deadline === undefined) return this.settled;
    if (deadline.aborted) return;
    let passed = (): void => {};
    const timedOut = new Promise<void>((resolve) => {
      passed = () => resolve();
      deadline.addEventListener("abort", passed, { once: true });
    });
    await Promise.race([this.settled, timedOut]);
    deadline.removeEventListener("abort", passed);
  }

  /** The version a batch carries. The first read chooses it, if the search has not yet. */
  read(): string {
    if (this.chosen === undefined) {
      this.choose({ version: UNKNOWN, source: "the first batch left before the search had finished" });
    }
    return this.chosen?.version ?? UNKNOWN;
  }

  private choose(chosen: Chosen): void {
    if (this.chosen !== undefined) return;
    this.chosen = chosen;
    this.log.debug(`version: ${chosen.version}, from ${chosen.source}`);
  }
}
