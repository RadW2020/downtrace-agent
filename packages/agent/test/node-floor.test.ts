import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { Logger } from "../src/log.ts";
import { NODE_FLOOR, unsupportedNode } from "../src/node-floor.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * DT-131. The package declares no `engines`, because yarn 1 enforces it: adding the instrumentation to one app of a
 * workspace failed the install of every other app, still on Node 18. The floor is enforced as the package loads
 * instead: one warning, and an instrumentation that does nothing.
 *
 * The children here run a supported Node told it is an older one, which shows what the entry points decide. What
 * it cannot show is a syntax or an API the old runtime lacks failing before the check runs; that is why
 * `scripts/pack-test.sh --below-floor` runs the packed package on a real Node 18, in CI.
 */

const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const OLD = "18.20.8";
const BELOW = new RegExp(
  `^Node\\.js ${OLD.replaceAll(".", "\\.")} is not supported: it needs Node\\.js ${NODE_FLOOR} or newer$`,
);

/** A preload that makes the child's Node say it is `version`: `process.versions.node` is configurable. */
function claiming(version: string): string[] {
  const source = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(source)}`];
}

/**
 * A token and a URL, and the start-up's own lines asked for: an instrumentation that started says `started:`. The
 * URL is the discard port; sending is what `scripts/pack-test.sh --below-floor` watches, with a sink.
 */
const CONFIGURED = { DOWNTRACE_TOKEN: "dt_test", DOWNTRACE_URL: "http://127.0.0.1:9", DOWNTRACE_DEBUG: "1" };

/** What a child prints when it has run: whether anything listens to the requests it serves and makes. */
const PROBE = `import dc from "node:diagnostics_channel";
console.log(JSON.stringify({ attached: dc.hasSubscribers("http.server.request.start") || dc.hasSubscribers("http.client.request.start") }));`;

/** The parent's environment, minus the instrumentation's own variables and `NODE_PATH`, plus what a case sets. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DOWNTRACE_") || key === "NODE_PATH") delete env[key];
  return { ...env, ...extra };
}

function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

describe("the oldest Node the package runs on", () => {
  it("turns away a Node below the floor, naming it and the floor", () => {
    expect(unsupportedNode(OLD)).toMatch(BELOW);
    for (const version of ["16.20.2", `${NODE_FLOOR - 1}.99.0`]) {
      expect(unsupportedNode(version)).toBe(
        `Node.js ${version} is not supported: it needs Node.js ${NODE_FLOOR} or newer`,
      );
    }
  });

  it("lets the floor and everything after it through", () => {
    for (const version of [`${NODE_FLOOR}.0.0`, `${NODE_FLOOR}.19.5`, "22.12.0", "26.13.0"]) {
      expect(unsupportedNode(version), version).toBeUndefined();
    }
  });

  it("turns away a version it cannot read, rather than guess", () => {
    for (const version of ["", "v18.20.8", "unknown"]) expect(unsupportedNode(version), version).toBeDefined();
  });

  it("is stated in the README, which is where it is looked for now that no engines field says it", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`Node.js ${NODE_FLOOR} or newer`);
    expect(readme).not.toContain("`engines`");
  });
});

describe("register on a Node below the floor", () => {
  it("warns once, naming the version and the floor, and starts nothing, configured or not", async () => {
    for (const env of [childEnv(), childEnv(CONFIGURED)]) {
      const args = [...claiming(OLD), "--import", register, "--input-type=module", "-e", PROBE];
      const { code, stdout, stderr } = await runNode(args, env);
      expect(code, stderr).toBe(0);
      // The one line is the whole of what it says, even with DOWNTRACE_DEBUG asking for the start-up's lines.
      expect(lines(stderr)).toEqual([expect.stringMatching(/^\[downtrace\] instrumentation disabled: /)]);
      expect(stderr.replace("[downtrace] instrumentation disabled: ", "").trim()).toMatch(BELOW);
      expect(JSON.parse(stdout)).toEqual({ attached: false });
    }
  });

  it("starts as before on the floor itself, which is what makes the probe above worth reading", async () => {
    const args = [...claiming(`${NODE_FLOOR}.0.0`), "--import", register, "--input-type=module", "-e", PROBE];
    const { code, stdout, stderr } = await runNode(args, childEnv(CONFIGURED));
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain("instrumentation disabled");
    expect(stderr).toMatch(/\[downtrace\] started/);
    expect(JSON.parse(stdout)).toEqual({ attached: true });
  });
});

describe("downtrace on a Node below the floor", () => {
  // In a directory of its own: were the check to let a command through, `init` would write its file there, and
  // not into this package.
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dt-floor-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([[[]], [["--version"]], [["--help"]], [["check"]], [["init", "--json"]]])(
    "says so in one line and exits 2, with no stack trace: %j",
    async (argv) => {
      const { code, stdout, stderr } = await runNode([...claiming(OLD), cli, ...argv], childEnv(), dir);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(lines(stderr)).toEqual([expect.stringMatching(/^downtrace: /)]);
      expect(stderr.replace(/^downtrace: /, "").trim()).toMatch(BELOW);
    },
  );
});

describe("an agent the application starts itself, on a Node below the floor", () => {
  it("attaches nothing, and warns once however many times it is started", async () => {
    const warnings: string[] = [];
    const log: Logger = { warn: (message) => warnings.push(message), debug: () => {} };
    const agent = new Agent(testConfig("http://127.0.0.1:9"), { log, nodeVersion: OLD });
    agent.start();
    agent.start();
    expect(agent.observers).toBeUndefined();
    expect(agent.stats.disabled).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.replace("instrumentation disabled: ", "")).toMatch(BELOW);
    await agent.stop();
  });

  it("starts on the floor itself", async () => {
    const warnings: string[] = [];
    const log: Logger = { warn: (message) => warnings.push(message), debug: () => {} };
    const agent = new Agent(testConfig("http://127.0.0.1:9"), { log, nodeVersion: `${NODE_FLOOR}.0.0` });
    agent.start();
    try {
      expect(agent.observers).toBeDefined();
      expect(warnings).toEqual([]);
    } finally {
      await agent.stop();
    }
  });
});
