import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Interval, PROTOCOL_VERSION } from "@downtrace/protocol";
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
    });
    sender.enqueue(interval(1));
    await sender.flush();
    expect((await readFile(path, "utf8")).trim()).toBe(sent);
  });
});
