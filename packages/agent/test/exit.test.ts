import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * What a process that calls `process.exit()` without waiting keeps, when it only writes (DT-79, ADR 0230).
 *
 * A test run lasts seconds and the profile's window a minute, so what a run keeps of its profile is what the
 * process hands over on the way out; a runner that ends with an explicit exit hands over nothing, because the
 * call waits for no promise and fires no `beforeExit`. In the inspection mode with no cloud behind it the
 * instrumentation writes what it holds on `exit`, the last thing that runs, and says the process left by it.
 *
 * Asked of **real processes**: a process that does not end cannot prove anything about how it ended. The
 * rest of the ways of ending are `shutdown.test.ts` and `endings.test.ts`; what is asked here is the same
 * five, in the inspection mode.
 */

const agentDir = fileURLToPath(new URL("..", import.meta.url));
const backend = pathToFileURL(join(agentDir, "test/support/runners/backend.mjs")).href;

/** What visiting `COMMON_PATHS` leaves in a profile, as the instrumentation names the routes. */
const COMMON_ROUTES = ["GET /products", "GET /products/:id", "GET /me"];

interface Batch {
  ending?: string;
  intervals: Array<{ endpoints?: Array<{ method: string; route: string }> }>;
  profile?: { endpoints: Array<{ method: string; route: string; operations: Array<{ kind: string }> }> };
  exceptions?: Array<{ kind: string }>;
}

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Every batch the inspection file holds, in order. */
  batches: Batch[];
}

const dirs: string[] = [];
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()?.();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The environment of a process of the user's, with nothing of this run's own instrumentation in it. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("DOWNTRACE_")) env[name] = value;
  }
  return env;
}

/**
 * Runs a script the way a user runs one — `--import @downtrace/agent/register` — with the inspection mode on and no
 * cloud, unless `env` says otherwise, and reads what it wrote.
 */
async function run(script: string, env: Record<string, string> = {}): Promise<Run & { file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "downtrace-exit-"));
  dirs.push(dir);
  const file = join(dir, "batches.jsonl");
  const child = spawn(
    process.execPath,
    ["--import", `${agentDir}src/register.ts`, "--input-type=module", "-e", script],
    {
      env: { ...cleanEnv(), DOWNTRACE_INSPECT: file, DOWNTRACE_ENV: "test", ...env },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const written = env.DOWNTRACE_INSPECT ?? file;
  return { ...ended, stdout, stderr, file, batches: batchesIn(written) };
}

/** Every batch in a file, or none when nothing was ever written to it. */
function batchesIn(file: string): Batch[] {
  if (file === "stderr" || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Batch);
}

const routesOf = (profile: Batch["profile"]): string[] =>
  (profile?.endpoints ?? []).map((e) => `${e.method} ${e.route}`).sort();

/** Serves some requests the way a test run does, then does `ending` with the process. */
const afterRequests = (ending: string): string => `
  import { startBackend, visit, COMMON_PATHS } from "${backend}";
  import { shutdown } from "${agentDir}src/registered.ts";
  const server = await startBackend();
  await visit(server, COMMON_PATHS);
  ${ending}
`;

describe("a process that exits without waiting, when the instrumentation only writes", () => {
  // The explicit exit, the second of ERR-04's three ways a process ends, in the mode the comparison before the
  // deploy runs in.
  //
  // covers: ERR-04
  it("keeps the profile of everything the tests called, and says it left by exit", async () => {
    const left = await run(afterRequests("process.exit(0);"));

    expect(left.code, left.stderr).toBe(0);
    expect(left.batches, "one batch: what was held when the process left").toHaveLength(1);
    const [batch] = left.batches as [Batch];
    expect(routesOf(batch.profile)).toEqual([...COMMON_ROUTES].sort());
    // What each route ran, and not only that it was called: a call, which is what the backend's handler makes.
    for (const endpoint of batch.profile?.endpoints ?? []) {
      expect(
        endpoint.operations.map((o) => o.kind),
        endpoint.route,
      ).toEqual(["call"]);
    }
    // The aggregates of the same interval travel beside it: the profile is compared by how many times per request.
    expect(batch.intervals).toHaveLength(1);
    expect(batch.intervals[0]?.endpoints?.map((e) => `${e.method} ${e.route}`)).toEqual(
      expect.arrayContaining(COMMON_ROUTES),
    );
    expect(batch.ending).toBe("exit");
  });

  it("writes it once when the application did wait", async () => {
    // `shutdown()` hands over the interval and the profile by the orderly path; the exit that follows has nothing
    // left to write and must not write it a second time, or a run that did everything right would count twice.
    const left = await run(afterRequests("await shutdown();\nprocess.exit(0);"));

    expect(left.code, left.stderr).toBe(0);
    expect(left.batches).toHaveLength(1);
    expect(routesOf(left.batches[0]?.profile)).toEqual([...COMMON_ROUTES].sort());
    expect(left.batches[0]?.ending).toBe("exit");
  });

  it("writes it once when the event loop empties", async () => {
    // The orderly end: `beforeExit` writes it, says `idle`, and the `exit` that follows is a no-op.
    const left = await run(afterRequests("await server.stop();"));

    expect(left.code, left.stderr).toBe(0);
    expect(left.batches).toHaveLength(1);
    expect(routesOf(left.batches[0]?.profile)).toEqual([...COMMON_ROUTES].sort());
    expect(left.batches[0]?.ending).toBe("idle");
  });

  it("writes standard error when that is where the batches go", async () => {
    // The other destination of the inspection mode: a descriptor and not a path, which has its own blocking call.
    const left = await run(afterRequests("process.exit(0);"), { DOWNTRACE_INSPECT: "stderr" });

    expect(left.code).toBe(0);
    const lines = left.stderr.split("\n").filter((line) => line.startsWith("{"));
    expect(lines).toHaveLength(1);
    const batch = JSON.parse(lines[0] ?? "") as Batch;
    expect(routesOf(batch.profile)).toEqual([...COMMON_ROUTES].sort());
    expect(batch.ending).toBe("exit");
  });

  it("writes nothing when the process had observed nothing", async () => {
    // A helper process of a runner that serves no request and leaves with `process.exit()` has nothing to keep.
    // An empty batch from each of them would be a line in the file for nobody to read.
    const left = await run("process.exit(0);");

    expect(left.code).toBe(0);
    expect(left.batches).toEqual([]);
  });

  // Invariant 2 has no exception for a diagnostic tool, and the exit code is the application's own.
  it("leaves with the exit code it was given when the destination cannot be written", async () => {
    const left = await run(afterRequests("process.exit(3);"), {
      DOWNTRACE_INSPECT: "/no/such/directory/batches.jsonl",
    });

    expect(left.code).toBe(3);
    expect(left.stderr).toContain("could not write the inspection file");
  });
});

describe("the other ways of ending, in the same mode", () => {
  // The exception that kills the process is lost, in every mode: ERR-04 says so, and a write on the way out is
  // not allowed to turn it into the one mode in which it is not (ADR 0230). The process ends exactly as it would
  // have, and what the interval in hand held goes with it.
  //
  // covers: ERR-04
  it.each([
    ["an exception nobody caught", 'setTimeout(() => { throw new TypeError("boom in a timer"); }, 5);'],
    ["a promise rejected with nothing to catch it", 'Promise.reject(new TypeError("boom in a promise"));'],
  ])("writes nothing for %s, and the process still dies of it", async (_what, kill) => {
    const left = await run(afterRequests(`${kill}\nsetTimeout(() => {}, 30_000);`));

    expect(left.code, "it ends as it would have without the instrumentation").toBe(1);
    expect(left.stderr).toContain("boom in a");
    expect(left.batches, "what the interval in hand held is lost with the process").toEqual([]);
  });

  it("writes everything when the application handled the exception and leaves by exit", async () => {
    // A handler of its own is what keeps the process alive, so nothing is dying: the exception is part of what the
    // process saw, and it leaves like any other that called `process.exit()`.
    const left = await run(
      afterRequests(`
        process.on("uncaughtException", () => {});
        setTimeout(() => { throw new TypeError("survived"); }, 5);
        setTimeout(() => process.exit(0), 50);
      `),
    );

    expect(left.code, left.stderr).toBe(0);
    expect(left.batches).toHaveLength(1);
    const [batch] = left.batches as [Batch];
    expect(routesOf(batch.profile)).toEqual([...COMMON_ROUTES].sort());
    expect(batch.exceptions?.map((e) => e.kind)).toEqual(["uncaught"]);
    expect(batch.ending).toBe("exit");
  });
});

describe("the same process with a cloud behind it", () => {
  /** Counts what reaches it and answers like the cloud does. */
  async function sink(): Promise<{ url: string; batches: () => number }> {
    let batches = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        batches += 1;
        res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"inserted":1}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(() => new Promise<void>((r) => server.close(() => r())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, batches: () => batches };
  }

  // The README says of the inspection mode with a cloud that what you read is what actually went out. A batch
  // written on the way out and sent nowhere would make it say what never left, and the loss the table of endings
  // states would stop being true for the one mode a deployment is audited in.
  //
  // covers: ERR-04
  it("loses its last batch as the table of endings says, and writes nothing in its place", async () => {
    const cloud = await sink();
    const left = await run(afterRequests("process.exit(0);"), {
      DOWNTRACE_URL: cloud.url,
      DOWNTRACE_TOKEN: "t",
      DOWNTRACE_INTERVAL_MS: "60000",
    });

    expect(left.code, left.stderr).toBe(0);
    // Nobody waited for anything, so nothing reached the cloud...
    await new Promise((r) => setTimeout(r, 300));
    expect(cloud.batches(), "the batch arrived without anybody waiting for it").toBe(0);
    // ...and the file, which records what was sent, has nothing it was not.
    expect(left.batches).toEqual([]);
  });
});
