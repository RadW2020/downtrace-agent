import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { Logger } from "../src/log.ts";
import { NODE_FLOOR, unsupportedNode } from "../src/node-floor.ts";
import { AGENT_VERSION } from "../src/version.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * DT-131. The package declares no `engines`, because yarn 1 enforces it: adding the instrumentation to one app of a
 * workspace failed the install of every other app, still on Node 18. The floor is enforced as the package loads
 * instead: one warning, and an instrumentation that does nothing.
 *
 * DT-164. The floor is a version, 18.19.0, and not a major: Node 18 before 18.19 lacks
 * `diagnostics_channel.tracingChannel`, which the package calls (ADR 0257).
 *
 * The children here run a supported Node told it is an older one, which shows what the entry points decide. What
 * it cannot show is a syntax or an API the old runtime lacks failing before the check runs; that is why
 * `scripts/pack-test.sh --below-floor` runs the packed package on a real Node 18.18, in CI, and `--consume-only` on a
 * real Node 18.19.0.
 */

const register = fileURLToPath(new URL("../src/register.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
/** The last Node 18 before the floor, which CI runs `--below-floor` on. */
const OLD = "18.18.2";
const escaped = (text: string): string => text.replaceAll(".", "\\.");
const BELOW = new RegExp(
  `^Node\\.js ${escaped(OLD)} is not supported: it needs Node\\.js ${escaped(NODE_FLOOR)} or newer$`,
);

/** A preload that makes the child's Node say it is `version`: `process.versions.node` is configurable. */
function claiming(version: string): string[] {
  const source = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(source)}`];
}

/**
 * A preload that takes `import.meta.resolve` from every module of the package's source as it loads, as Node 20 before
 * 20.6 has it: only behind a flag (DT-142). With `claiming`, a Node that says it is one of those and lacks what they
 * lack. The line goes after a shebang, which has to stay first, and before everything else otherwise. `src` is there
 * for the test that shows the preload works.
 */
function withoutImportMetaResolve(src: string = new URL("../src/", import.meta.url).href): string[] {
  const hooks = `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith(${JSON.stringify(src)})) return loaded;
    const text = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString();
    const line = "delete import.meta.resolve;\\n";
    return { ...loaded, source: text.startsWith("#!") ? text.replace("\\n", "\\n" + line) : line + text };
  },
});`;
  return ["--import", `data:text/javascript,${encodeURIComponent(hooks)}`];
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
  it("is Node 18.19.0", () => {
    expect(NODE_FLOOR).toBe("18.19.0");
  });

  it("turns away a Node below the floor, by its major or its minor, naming it and the floor", () => {
    expect(unsupportedNode(OLD)).toMatch(BELOW);
    for (const version of ["10.24.1", "16.20.2", "17.9.1", "18.0.0", "18.17.1", "18.18.2"]) {
      expect(unsupportedNode(version), version).toBe(
        `Node.js ${version} is not supported: it needs Node.js ${NODE_FLOOR} or newer`,
      );
    }
  });

  it("lets the floor and everything after it through, by its patch, its minor or its major", () => {
    const after = ["18.19.0", "18.19.1", "18.20.8", "20.0.0", "20.5.1", "22.12.0", "24.13.0", "26.13.0"];
    for (const version of after) expect(unsupportedNode(version), version).toBeUndefined();
  });

  // Node 19 is an odd release past its end of life, and is promised nothing (ADR 0257). It is turned away whole: before
  // 19.9 it lacks `tracingChannel`, whose absence ends the application at start-up. Staying off is the side on which
  // nothing breaks.
  it("turns Node 19 away, every release of it", () => {
    for (const version of ["19.0.0", "19.8.1", "19.9.0", "19.9.0-pre"]) {
      expect(unsupportedNode(version), version).toBe(
        `Node.js ${version} is not supported: it needs Node.js ${NODE_FLOOR} or newer, other than 19`,
      );
    }
  });

  // A floor with a patch of its own shows that the patch is compared too, as the major and the minor are: the floor
  // is a version, not a major (DT-164).
  it("compares the patch as well as the major and the minor", () => {
    expect(unsupportedNode("20.6.0", "20.6.1")).toBe(
      "Node.js 20.6.0 is not supported: it needs Node.js 20.6.1 or newer",
    );
    for (const version of ["20.6.1", "20.6.2", "20.7.0", "21.0.0"]) {
      expect(unsupportedNode(version, "20.6.1"), version).toBeUndefined();
    }
    // Numbers, not text: 9 is below 10 and 100 above it, which a comparison of strings gets wrong.
    expect(unsupportedNode("18.9.0", "18.10.0")).toBeDefined();
    expect(unsupportedNode("18.100.0", "18.10.0")).toBeUndefined();
  });

  // What Node's own pre-releases say: the release they lead to, with a suffix.
  it("reads a pre-release by its version", () => {
    expect(unsupportedNode("24.0.0-pre")).toBeUndefined();
    expect(unsupportedNode("18.18.0-rc.1")).toBeDefined();
  });

  it("turns away a version it cannot read, rather than guess", () => {
    for (const version of ["", "v18.20.8", "unknown", "18", "18.19", "18.x.0", "18.19.0.1"]) {
      expect(unsupportedNode(version), version).toBeDefined();
    }
  });

  it("is stated in the requirements, which is where it is looked for now that no engines field says it", async () => {
    const requirements = await readFile(new URL("../guide/production.md", import.meta.url), "utf8");
    expect(requirements).toContain(`Node.js ${NODE_FLOOR} or newer`);
    expect(requirements).not.toContain("`engines`");
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
    const args = [...claiming(NODE_FLOOR), "--import", register, "--input-type=module", "-e", PROBE];
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

describe("downtrace on Node 20 before 20.6, above the floor and without `import.meta.resolve`", () => {
  // It ended in `TypeError: (intermediate value).resolve is not a function` and a stack trace, on every command:
  // the command looked its own `register` entry up with `import.meta.resolve` before it read its arguments (DT-142).
  const NODE_20_5 = [...claiming("20.5.1"), ...withoutImportMetaResolve()];

  it("prints its version", async () => {
    const { code, stdout, stderr } = await runNode([...NODE_20_5, cli, "--version"], childEnv());
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe(`${AGENT_VERSION}\n`);
  });

  it("prints its help", async () => {
    const { code, stdout, stderr } = await runNode([...NODE_20_5, cli, "--help"], childEnv());
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("downtrace check");
  });

  // What makes the two above worth reading: the preload does take the function away, with a shebang and without.
  it("runs where the preload leaves a module no `import.meta.resolve`", async () => {
    // Its real path: the URL a module loads from is, and macOS keeps the temporary directory behind a symlink.
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "dt-meta-")));
    try {
      const probe = "console.log(typeof import.meta.resolve);\n";
      await writeFile(path.join(dir, "plain.mjs"), probe);
      await writeFile(path.join(dir, "bin.mjs"), `#!/usr/bin/env node\n${probe}`);
      const hooked = withoutImportMetaResolve(pathToFileURL(`${dir}${path.sep}`).href);
      for (const file of ["plain.mjs", "bin.mjs"]) {
        const { code, stdout, stderr } = await runNode([...hooked, path.join(dir, file)], childEnv());
        expect(code, stderr).toBe(0);
        expect(stdout, file).toBe("undefined\n");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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
    const agent = new Agent(testConfig("http://127.0.0.1:9"), { log, nodeVersion: NODE_FLOOR });
    agent.start();
    try {
      expect(agent.observers).toBeDefined();
      expect(warnings).toEqual([]);
    } finally {
      await agent.stop();
    }
  });
});
