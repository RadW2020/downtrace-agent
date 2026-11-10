import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI, cleanEnv, REGISTER_URL } from "./support/check-project.ts";

/**
 * DT-167. `scripts/pack-test.sh` runs `support/consumer-commands.mjs` on every Node CI consumes the packed package on,
 * 18.19.0 included: `check`, `verify`, `report` and `compare` on a small project, with every answer pinned. Run here,
 * on the Node this package is built with and against its source, it is what makes the pinned answers this Node's: the
 * same file then says whether an older Node answers the same, and fails naming what it said instead.
 */

const SCENARIO = fileURLToPath(new URL("./support/consumer-commands.mjs", import.meta.url));

function scenario(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCENARIO, ...args], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the commands a consumer runs, as pack-test runs them on each Node", () => {
  it("answer on this Node as the scenario pins: check, verify, report and compare", { timeout: 120_000 }, async () => {
    const { code, stdout, stderr } = await scenario([CLI, REGISTER_URL]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout.trimEnd().split("\n")).toEqual([
      "  check, nothing changed: exit 0, as pinned",
      "  check, a route that calls twice what it called once: exit 1, as pinned",
      "  report: exit 0, as pinned",
      "  compare: exit 1, as pinned",
      "  verify, a token the cloud knows: exit 0, as pinned",
      "  verify, a token it does not: exit 1, as pinned",
    ]);
  });

  // A scenario that cannot fail proves nothing on the Node it is run on: here, a command that exits 0 and says nothing.
  it("fails, naming the answer and what it was instead, when the command does not answer as pinned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-consumer-test-"));
    try {
      const silent = join(dir, "silent.mjs");
      await writeFile(silent, "");
      const { code, stdout, stderr } = await scenario([silent, REGISTER_URL]);
      expect(code, stderr).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toMatch(
        /^✗ check, nothing changed: exit 0, want 0\n {2}answered \{"failure":null,"routes":\[\]\}\n/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says how it is run when it is not given the command and the instrumentation", async () => {
    const { code, stderr } = await scenario([]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/^usage: /);
  });
});
