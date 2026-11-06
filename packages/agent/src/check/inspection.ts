import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "@downtrace/protocol";
import { RunReader, type RunTally } from "./read.ts";

/**
 * A file `DOWNTRACE_INSPECT` wrote, read for `downtrace report` and `downtrace compare`: with the reader of `check`'s
 * runs (`read.ts`), and with the number of each line it could not read.
 *
 * `check` reads files it made itself; these two read a file a person hands them, which may be anything: a log, the
 * standard error of an application that wrote its batches there among its own lines, the batches of a protocol this
 * version does not know. So each line is told apart. A batch is read. A line that is not one is left out and said by
 * its number — the line a process was ending in the middle of, a line of the application's own. A file with no batch
 * in it is not one `DOWNTRACE_INSPECT` wrote, and is said with its first line and why. And a batch of a protocol this
 * version cannot read stops the reading at its line: half a file read would undercount every route without a word.
 */

/** A protocol this version reads: any minor of v0, whose fields are only ever added, and always optional. */
const READABLE_PROTOCOL = /^0\.\d+\.\d+$/;

/** How many of the lines that could not be read are named; the rest are counted. */
export const LINES_NAMED = 20;

/** Why a file could not be read as one `DOWNTRACE_INSPECT` wrote. Stable: an agent branches on these. */
export const INSPECTION_FAILURES = [
  "unreadable-file",
  "not-inspection-file",
  "unreadable-protocol",
  "no-requests",
] as const;
export type InspectionFailureCode = (typeof INSPECTION_FAILURES)[number];

export interface InspectionFailure {
  code: InspectionFailureCode;
  message: string;
  /** What to do about it, when there is something. */
  advice: string | null;
  /** The line it is about, counted from 1; null when it is about the whole file. */
  line: number | null;
}

/** What was read of one file, as a report says it. */
export interface FileReport {
  /** As the command line named it. */
  file: string;
  /** Processes that wrote at least one batch. */
  processes: number;
  batches: number;
  requests: number;
  /** Routes that served at least one request. */
  routes: number;
  profileWindows: number;
  /** Lines, and entries of a batch, that could not be read. */
  malformed: number;
  /** The first lines that could not be read, whole or in part, by number from 1. */
  unreadLines: number[];
  /** What the instrumentation said it observed, by driver. */
  observers: Record<string, string>;
}

export interface Inspection {
  tally: RunTally;
  report: FileReport;
}

export type InspectionRead = { ok: true; inspection: Inspection } | { ok: false; failure: InspectionFailure };

/**
 * What follows requests that no profile window covers, in a file a person recorded: the application may still have
 * been running when it was read, which a run of `check` never is.
 */
export const UNPROFILED_IN_FILE =
  "This happens when the file is read before the profile window that covers those requests closed — a process writes " +
  "one every minute by default (DOWNTRACE_PROFILE_MS), and as it ends: stop the application, then read the file — or " +
  "when a process was ended while requests were in flight in it, and what they did was lost with it.";

const NO_REQUESTS_ADVICE =
  "Start the application with DOWNTRACE_INSPECT set to this file, send it requests, and read the file after the " +
  "application has written them: a process writes what it counted every ten seconds by default " +
  "(DOWNTRACE_INTERVAL_MS), and as it ends.";

/** What a person reads about a file that could not be opened: the system's words for the usual three, its message else. */
function whyUnreadable(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "there is no such file";
  if (code === "EISDIR") return "it is a directory";
  if (code === "EACCES") return "permission denied";
  return err instanceof Error ? err.message : String(err);
}

function failed(code: InspectionFailureCode, message: string, more: Partial<InspectionFailure> = {}): InspectionRead {
  return { ok: false, failure: { code, message, advice: null, line: null, ...more } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a line is not read, and the reading stops; or why it is left out; or nothing, when it is a batch. */
type Verdict = { stop: string } | { skip: string } | { batch: unknown };

function lineVerdict(line: string): Verdict {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { skip: "it is not JSON" };
  }
  if (!isRecord(value) || !("protocol" in value)) return { skip: "it is not a batch: it says no protocol" };
  const { protocol } = value;
  if (typeof protocol !== "string" || !READABLE_PROTOCOL.test(protocol)) {
    const said = JSON.stringify(protocol)?.slice(0, 40) ?? String(protocol);
    return {
      stop: `it is a batch of protocol ${said}, and this version reads protocol 0 (it writes ${PROTOCOL_VERSION})`,
    };
  }
  return { batch: value };
}

/**
 * Reads the file at `path`, a line at a time, and says it as `name`. A file that cannot be opened, that holds no
 * batch, whose batches speak a protocol this version cannot read, or in which no request was counted, is a failure,
 * with the line it is about; anything else is read, and what could not be is counted and named.
 */
export async function readInspection(path: string, name: string): Promise<InspectionRead> {
  const reader = new RunReader();
  const unread: number[] = [];
  /** Lines left out whole: the reader never saw them, so they are not among what it counted. */
  let skipped = 0;
  let first: { line: number; why: string } | undefined;
  let lines = 0;
  let stopped: InspectionRead | undefined;
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    for await (const text of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
      lines += 1;
      if (text.trim() === "") continue;
      const verdict = lineVerdict(text);
      if ("stop" in verdict) {
        stopped = failed("unreadable-protocol", `line ${lines} of ${name} cannot be read: ${verdict.stop}`, {
          line: lines,
          advice: "Read it with the version of @downtrace/agent that wrote it, or a later one.",
        });
        break;
      }
      if ("skip" in verdict) skipped += 1;
      else if (reader.addBatch(verdict.batch) === 0) continue;
      if (unread.length < LINES_NAMED) unread.push(lines);
      first ??= { line: lines, why: "skip" in verdict ? verdict.skip : "it could not be read as a batch" };
    }
  } catch (err) {
    return failed("unreadable-file", `${name} could not be read: ${whyUnreadable(err)}`);
  } finally {
    stream.destroy();
  }
  if (stopped !== undefined) return stopped;

  const tally = reader.finish();
  if (tally.batches === 0) {
    if (first === undefined) {
      return failed("not-inspection-file", `${name} is empty: there is no batch in it`, { advice: NO_REQUESTS_ADVICE });
    }
    return failed(
      "not-inspection-file",
      `${name} is not a file DOWNTRACE_INSPECT wrote: no line of it is a batch, and line ${first.line} is the first ` +
        `that fails: ${first.why}`,
      {
        line: first.line,
        advice: "Pass the file DOWNTRACE_INSPECT names: one JSON line per batch, as the instrumentation sends it.",
      },
    );
  }
  tally.malformed += skipped;
  if (tally.requests === 0) {
    return failed(
      "no-requests",
      `${name} holds ${tally.batches} batch${tally.batches === 1 ? "" : "es"} and no request: no route of the ` +
        "application answered while it was written",
      { advice: NO_REQUESTS_ADVICE },
    );
  }
  return {
    ok: true,
    inspection: {
      tally,
      report: {
        file: name,
        processes: tally.processes,
        batches: tally.batches,
        requests: tally.requests,
        routes: [...tally.routes.values()].filter((route) => route.requests > 0).length,
        profileWindows: tally.profileWindows,
        malformed: tally.malformed,
        unreadLines: unread,
        observers: tally.observers,
      },
    },
  };
}
