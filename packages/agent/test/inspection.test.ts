import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@downtrace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type InspectionRead, LINES_NAMED, readInspection } from "../src/check/inspection.ts";
import { batch, endpoint, fileOf, interval, operation, profile, profileEndpoint } from "./support/check-batches.ts";

/**
 * A file `DOWNTRACE_INSPECT` wrote, as `downtrace report` and `downtrace compare` read it: a file a person hands
 * over, which may be anything. What is a batch is read; what is not is left out and named by its line; a file with no
 * batch, or with a batch of a protocol this version cannot read, is refused with the line that fails.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function room(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "downtrace-inspection-"));
  dirs.push(made);
  return made;
}

async function read(text: string): Promise<InspectionRead> {
  const path = join(await room(), "run.jsonl");
  await writeFile(path, text);
  return readInspection(path, "run.jsonl");
}

/** A batch of one process that served `requests` requests to `GET /p`, each running one query. */
function served(process: string, requests: number, start = 1000): unknown {
  return batch(process, {
    intervals: [interval(start, 1000, [endpoint("GET", "/p", requests, { requestsWithCalls: requests })])],
    profile: profile(start, 1000, [profileEndpoint("GET", "/p", [operation("query", "q1", "SELECT 1", requests)])]),
  });
}

function ok(result: InspectionRead) {
  if (!result.ok) throw new Error(`expected a reading, got ${result.failure.code}: ${result.failure.message}`);
  return result.inspection;
}

function failure(result: InspectionRead) {
  if (result.ok) throw new Error("expected a failure, got a reading");
  return result.failure;
}

describe("reading a file DOWNTRACE_INSPECT wrote", () => {
  it("reads every batch of every process, and names nothing when it read everything", async () => {
    const { report, tally } = ok(await read(fileOf(served("a", 3), served("b", 2))));
    expect(report).toMatchObject({
      file: "run.jsonl",
      processes: 2,
      batches: 2,
      requests: 5,
      routes: 1,
      profileWindows: 2,
      malformed: 0,
      unreadLines: [],
    });
    expect(tally.routes.get("GET /p")?.operations.get("query:q1")?.executions).toBe(5);
  });

  it("leaves out a line cut in the middle by a process that ended, and names it", async () => {
    const whole = fileOf(served("a", 3), served("b", 2));
    const { report } = ok(await read(`${whole}\n${JSON.stringify(served("c", 4)).slice(0, 80)}`));
    expect(report).toMatchObject({ requests: 5, malformed: 1, unreadLines: [3] });
  });

  it("leaves out the application's own lines among the batches — its standard error — and counts blank lines", async () => {
    const text = [
      "Server listening on port 3000",
      JSON.stringify(served("a", 3)),
      "",
      '{"level":30,"msg":"request completed"}',
      JSON.stringify(served("a", 2, 2000)),
    ].join("\n");
    const { report } = ok(await read(text));
    expect(report).toMatchObject({ batches: 2, requests: 5, malformed: 2, unreadLines: [1, 4] });
  });

  it(`names the first ${LINES_NAMED} lines it could not read, and counts them all`, async () => {
    const noise = Array.from({ length: LINES_NAMED + 5 }, (_, i) => `log line ${i}`);
    const { report } = ok(await read([JSON.stringify(served("a", 1)), ...noise].join("\n")));
    expect(report.malformed).toBe(LINES_NAMED + 5);
    expect(report.unreadLines).toEqual(Array.from({ length: LINES_NAMED }, (_, i) => i + 2));
  });

  it("counts the entries of a batch it could not read, and names the line they are in", async () => {
    const torn = batch("a", {
      intervals: [interval(1000, 1000, [endpoint("GET", "/p", 2)]), { start: "soon" } as never],
    });
    const { report } = ok(await read(fileOf(served("b", 1), torn)));
    expect(report).toMatchObject({ requests: 3, malformed: 1, unreadLines: [2] });
  });

  it("reads a later minor of protocol 0, whose fields are only ever added", async () => {
    const later = { ...(served("a", 3) as Record<string, unknown>), protocol: "0.99.0", somethingNew: { x: 1 } };
    expect(ok(await read(fileOf(later))).report.requests).toBe(3);
  });

  it("reads lines that end in CRLF", async () => {
    const text = `${fileOf(served("a", 3), served("b", 1)).replaceAll("\n", "\r\n")}\r\n`;
    expect(ok(await read(text)).report).toMatchObject({ requests: 4, malformed: 0 });
  });
});

describe("a file it cannot read as one DOWNTRACE_INSPECT wrote", () => {
  it("is not an inspection file when no line is JSON, and says the first line and why", async () => {
    expect(failure(await read("hello\nworld\n"))).toMatchObject({
      code: "not-inspection-file",
      line: 1,
      message: expect.stringContaining("line 1 is the first that fails: it is not JSON"),
    });
  });

  it("is not an inspection file when its JSON lines are not batches: a log, a package.json", async () => {
    const said = failure(await read('\n{"level":30,"msg":"hi"}\n{"name":"app"}\n'));
    expect(said).toMatchObject({ code: "not-inspection-file", line: 2 });
    expect(said.message).toContain("it says no protocol");
  });

  it("is not an inspection file when its lines say a protocol and are no batch of it", async () => {
    const said = failure(await read(`{"protocol":"${PROTOCOL_VERSION}"}`));
    expect(said).toMatchObject({ code: "not-inspection-file", line: 1 });
    expect(said.message).toContain("it could not be read as a batch");
  });

  it("says an empty file is empty", async () => {
    expect(failure(await read("\n\n"))).toMatchObject({ code: "not-inspection-file", line: null });
    expect(failure(await read("")).message).toBe("run.jsonl is empty: there is no batch in it");
  });

  it("stops at the first batch of a protocol it cannot read, and names its line: half a file would undercount", async () => {
    const later = { ...(served("b", 2) as Record<string, unknown>), protocol: "1.0.0" };
    const said = failure(await read(`${fileOf(served("a", 3))}\n\n${fileOf(later, served("c", 1))}`));
    expect(said).toMatchObject({ code: "unreadable-protocol", line: 3 });
    expect(said.message).toContain('line 3 of run.jsonl cannot be read: it is a batch of protocol "1.0.0"');
    expect(said.advice).toContain("version of @downtrace/agent that wrote it");
  });

  it("does not take a protocol that is not a version for one", async () => {
    for (const protocol of [13, null, "0.13", "v0.13.0", { major: 0 }]) {
      const said = failure(await read(fileOf({ ...(served("a", 1) as Record<string, unknown>), protocol })));
      expect(said, JSON.stringify(protocol)).toMatchObject({ code: "unreadable-protocol", line: 1 });
    }
  });

  it("says there is no such file", async () => {
    const said = await readInspection(join(await room(), "nowhere.jsonl"), "nowhere.jsonl");
    expect(failure(said)).toMatchObject({
      code: "unreadable-file",
      line: null,
      message: "nowhere.jsonl could not be read: there is no such file",
    });
  });

  it("says a directory is a directory", async () => {
    const dir = join(await room(), "batches");
    await mkdir(dir);
    expect(failure(await readInspection(dir, "batches")).message).toBe("batches could not be read: it is a directory");
  });

  it("has nothing to say of a file whose batches counted no request, and says how to make one that has", async () => {
    // What a process that served nothing writes as it ends: its batch, and no interval.
    const said = failure(await read(fileOf(batch("a", {}), batch("b", {}))));
    expect(said).toMatchObject({ code: "no-requests", line: null });
    expect(said.message).toBe(
      "run.jsonl holds 2 batches and no request: no route of the application answered while it was written",
    );
    expect(said.advice).toContain("DOWNTRACE_INSPECT");
  });
});
