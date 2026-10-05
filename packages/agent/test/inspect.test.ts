import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Interval, PROTOCOL_VERSION, type Profile } from "@downtrace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.ts";
import { createInspector } from "../src/inspect.ts";
import type { Logger } from "../src/log.ts";
import { Sender } from "../src/transport.ts";

/**
 * `product.md` promises a local inspection mode twice, and it did not exist. It is the only way a user can check
 * invariant 5 against **their** application — their routes, their queries (gh-181).
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "downtrace-inspect-"));
  dirs.push(d);
  return d;
};

describe("configuring the inspection mode", () => {
  it("makes the token and the URL optional, so it can be tried before signing up for anything", () => {
    const result = configFromEnv({ DOWNTRACE_INSPECT: "stderr" });
    expect(result.ok, "reason" in result ? result.reason : "").toBe(true);
    if (!result.ok) return;
    expect(result.config.inspect).toBe("stderr");
    expect(result.config.token).toBe("");
    expect(result.config.url).toBe("");
  });

  it("still takes a token and a URL, so a running deployment can be audited without turning it off", () => {
    const result = configFromEnv({
      DOWNTRACE_TOKEN: "t",
      DOWNTRACE_URL: "http://cloud.test",
      DOWNTRACE_INSPECT: "/tmp/x.jsonl",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.inspect).toBe("/tmp/x.jsonl");
    expect(result.config.url).toBe("http://cloud.test");
  });

  // Without the inspection mode, nothing changes: a missing token is still a misconfiguration to be told about.
  it("keeps refusing to start with neither a destination nor a cloud", () => {
    const result = configFromEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("DOWNTRACE_TOKEN");
  });

  it("does not accept half a cloud even in inspection mode", () => {
    // A URL with no token is a mistake worth saying out loud, whether or not batches are also being written.
    const result = configFromEnv({ DOWNTRACE_URL: "http://cloud.test", DOWNTRACE_INSPECT: "stderr" });
    expect(result.ok).toBe(false);
  });
});

describe("what the inspector writes", () => {
  it("writes the body byte for byte, because a summary proves nothing", async () => {
    const dir = await tmp();
    const path = join(dir, "batches.jsonl");
    const inspector = createInspector(path, quiet);
    const body = '{"protocol":"0.6.0","intervals":[{"start":1}]}';
    await inspector?.write(body);
    await inspector?.write(body);
    expect(await readFile(path, "utf8")).toBe(`${body}\n${body}\n`);
  });

  it("keeps the normalised query text, which is the reason this exists", async () => {
    const dir = await tmp();
    const path = join(dir, "batches.jsonl");
    const inspector = createInspector(path, quiet);
    const body = JSON.stringify({
      profile: {
        endpoints: [{ operations: [{ hash: "abc", text: "SELECT id FROM products WHERE id = ?" }] }],
      },
    });
    await inspector?.write(body);
    const written = await readFile(path, "utf8");
    expect(written).toContain("SELECT id FROM products WHERE id = ?");
    expect(JSON.parse(written.trim())).toEqual(JSON.parse(body));
  });

  it("does nothing at all when no destination is set", () => {
    expect(createInspector(undefined, quiet)).toBeUndefined();
  });

  // Invariant 2 has no exception for a diagnostic tool.
  it("does not break the application when the destination cannot be written", async () => {
    const said: string[] = [];
    const noisy: Logger = { warn: (m) => said.push(m), debug: () => {} };
    const inspector = createInspector("/no/such/directory/anywhere/batches.jsonl", noisy);
    await expect(inspector?.write('{"a":1}')).resolves.toBeUndefined();
    await expect(inspector?.write('{"a":2}')).resolves.toBeUndefined();
    expect(said).toHaveLength(1);
  });

  it("writes to stderr when asked for stderr, and to no file", async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: replacing a stream method for one assertion
    (process.stderr as any).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await createInspector("stderr", quiet)?.write('{"a":1}');
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring what was replaced above
      (process.stderr as any).write = original;
    }
    expect(written.join("")).toContain('{"a":1}');
  });
});

describe("what the inspector writes on the way out", () => {
  // `process.on("exit")` is the last thing that runs, and a promise started there never settles: the line is
  // there when the call returns, or it is not there at all (DT-79, ADR 0230).
  it("has written the line when the call returns, byte for byte", async () => {
    const dir = await tmp();
    const path = join(dir, "batches.jsonl");
    const inspector = createInspector(path, quiet);
    const body = '{"protocol":"0.6.0","intervals":[{"start":1}]}';
    await inspector?.write(body);
    inspector?.writeOnExit(body);
    expect(readFileSync(path, "utf8")).toBe(`${body}\n${body}\n`);
  });

  // Invariant 2 has no exception for a diagnostic tool, and the application is leaving: its exit code is its own.
  it("does not break the application when the destination cannot be written, and says it once", () => {
    const said: string[] = [];
    const noisy: Logger = { warn: (m) => said.push(m), debug: () => {} };
    const inspector = createInspector("/no/such/directory/anywhere/batches.jsonl", noisy);
    expect(() => inspector?.writeOnExit('{"a":1}')).not.toThrow();
    expect(() => inspector?.writeOnExit('{"a":2}')).not.toThrow();
    expect(said).toHaveLength(1);
  });

  it("says it once for the two ways of writing, not once for each", async () => {
    // One destination that cannot be written is one mistake, and the operator has been told.
    const said: string[] = [];
    const noisy: Logger = { warn: (m) => said.push(m), debug: () => {} };
    const inspector = createInspector("/no/such/directory/anywhere/batches.jsonl", noisy);
    await inspector?.write('{"a":1}');
    inspector?.writeOnExit('{"a":2}');
    expect(said).toHaveLength(1);
  });
});

describe("what the sender does with a destination and no cloud", () => {
  const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });

  it("writes the batch and sends nothing", async () => {
    const dir = await tmp();
    const path = join(dir, "batches.jsonl");
    let calls = 0;
    const sender = new Sender({
      url: "",
      token: "",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      inspector: createInspector(path, quiet),
      now: () => 1_000_000,
    });
    sender.enqueue(interval(1));
    expect(await sender.flush()).toBe(true);

    // The one thing this mode promises: nothing left the machine.
    expect(calls).toBe(0);
    const written = JSON.parse((await readFile(path, "utf8")).trim());
    expect(written.intervals).toHaveLength(1);
    expect(written.protocol).toBe(PROTOCOL_VERSION);
    // And the queue is clear, so a long run does not pile up batches nobody will ever send.
    expect(sender.pending).toBe(0);
  });

  it("writes exactly what it sends when there is a cloud", async () => {
    const dir = await tmp();
    const path = join(dir, "batches.jsonl");
    let sent = "";
    const sender = new Sender({
      url: "http://cloud.test",
      token: "tok",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        sent = String(init?.body);
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      inspector: createInspector(path, quiet),
      now: () => 1_000_000,
    });
    sender.enqueue(interval(1));
    await sender.flush();
    expect((await readFile(path, "utf8")).trim()).toBe(sent);
  });
});

describe("what the sender writes when the process is leaving and nothing will run after it", () => {
  const interval = (start: number): Interval => ({ start, durationMs: 10_000, endpoints: [] });
  const profile: Profile = {
    start: 1,
    durationMs: 5_000,
    endpoints: [
      { method: "GET", route: "/orders", operations: [{ kind: "call", hash: "abc", count: 1, totalMs: 3, errors: 0 }] },
    ],
  };

  async function senderTo(path: string, cloud?: { url: string; token: string }) {
    let sent = 0;
    const sender = new Sender({
      url: cloud?.url ?? "",
      token: cloud?.token ?? "",
      agent: { name: "@downtrace/agent", version: "0.0.0", runtime: "node", runtimeVersion: "v24" },
      instance: { id: "i", hostname: "h", pid: 1 },
      deploy: { version: "v", environment: "test" },
      log: quiet,
      fetchImpl: (async () => {
        sent += 1;
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      inspector: createInspector(path, quiet),
      now: () => 1_000_000,
    });
    return { sender, sent: () => sent };
  }

  const batchesIn = (path: string) =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];

  it("writes the interval and the profile it holds, and says how the process left", async () => {
    const path = join(await tmp(), "batches.jsonl");
    const { sender } = await senderTo(path);
    sender.enqueue(interval(1));
    sender.enqueueProfile(profile);
    sender.dumpOnExit("exit");

    const [batch, ...rest] = batchesIn(path);
    expect(rest, "one batch, with everything in it").toEqual([]);
    expect(batch.intervals).toHaveLength(1);
    expect(batch.profile).toEqual(profile);
    expect(batch.ending).toBe("exit");
    expect(sender.pending).toBe(0);
  });

  it("writes it once, however many times it is asked", async () => {
    const path = join(await tmp(), "batches.jsonl");
    const { sender } = await senderTo(path);
    sender.enqueue(interval(1));
    sender.dumpOnExit("exit");
    sender.dumpOnExit("exit");
    expect(batchesIn(path)).toHaveLength(1);
  });

  it("writes nothing when there is nothing to keep", async () => {
    // A process that observed nothing has no interval and no profile, and an ending that nobody had declared is
    // not worth a blocking write by itself.
    const path = join(await tmp(), "batches.jsonl");
    const { sender } = await senderTo(path);
    sender.dumpOnExit("exit");
    expect(existsSync(path)).toBe(false);
  });

  it("keeps the ending a drain had declared before it, and writes it when no batch has said it", async () => {
    const path = join(await tmp(), "batches.jsonl");
    const { sender } = await senderTo(path);
    sender.declareEnding("signal");
    sender.dumpOnExit("exit");
    expect(batchesIn(path)).toEqual([expect.objectContaining({ ending: "signal", intervals: [] })]);
  });

  // The README says of the inspection mode with a cloud that what you read is what actually went out. A batch
  // written on the way out and sent nowhere would make it say what never left.
  it("writes nothing when a cloud is behind it", async () => {
    const path = join(await tmp(), "batches.jsonl");
    const { sender, sent } = await senderTo(path, { url: "http://cloud.test", token: "tok" });
    sender.enqueue(interval(1));
    sender.enqueueProfile(profile);
    sender.dumpOnExit("exit");
    expect(existsSync(path)).toBe(false);
    expect(sent()).toBe(0);
    expect(sender.pending, "and it is still queued, as it would be for a cloud that does not answer").toBe(1);
  });

  it("says it only writes when there is a destination and no cloud", async () => {
    const path = join(await tmp(), "batches.jsonl");
    expect((await senderTo(path)).sender.writesOnly).toBe(true);
    expect((await senderTo(path, { url: "http://cloud.test", token: "tok" })).sender.writesOnly).toBe(false);
  });
});
