import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ESC-16 when the application's `pg` comes in two ways: an `import` and a `require`. The tracker hooks each way once,
 * and its second hook unwraps its first wrapper only when that wrapper is on top. A wrapper of the instrumentation's
 * between the two hides it, and the tracker's query spans come out twice (ADR 0209, ADR 0247).
 *
 * The coexistence test in `coexistence.integration.test.ts` loads `pg` one way. These load it both ways, before the
 * first request and after it, in both load orders, beside the tracker alone. No database: a query that cannot connect
 * starts its span all the same, so they run in the fast suite.
 */
const appDir = fileURLToPath(new URL("..", import.meta.url));
const DOWNTRACE = fileURLToPath(new URL("../../agent/src/register.ts", import.meta.url));
const TRACKER = "./test/two-ways-in/instrument.mjs";

const ORDERS = {
  "the tracker alone": [TRACKER],
  "downtrace first": [DOWNTRACE, TRACKER],
  "the tracker first": [TRACKER, DOWNTRACE],
} as const;

async function spans(entry: string, imports: readonly string[], env: Record<string, string> = {}): Promise<number> {
  const child = spawn(process.execPath, [...imports.flatMap((m) => ["--import", m]), entry], {
    cwd: appDir,
    env: { ...process.env, DOWNTRACE_TOKEN: "", DOWNTRACE_URL: "", DOWNTRACE_INSPECT: "stderr", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  expect(code, stderr).toBe(0);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return (JSON.parse(line) as { spans: number }).spans;
}

describe("the tracker's pg spans when the application's pg comes in two ways", () => {
  for (const [order, imports] of Object.entries(ORDERS)) {
    it.each(["before", "after"])(
      `${order}: imported, and required %s the first request`,
      async (when) => {
        expect(await spans("test/two-ways-in/esm.mjs", imports, { REQUIRE: when })).toBe(1);
      },
      30_000,
    );

    it(`${order}: required, and imported during start-up`, async () => {
      expect(await spans("test/two-ways-in/cjs.cjs", imports)).toBe(1);
    }, 30_000);
  }
});
