#!/usr/bin/env node
import { tmpdir } from "node:os";
import { unsupportedNode } from "./node-floor.ts";

/**
 * `downtrace`: the command of this package. `check` compares two runs of the project's tests before a deploy, `init`
 * writes what `check` and a pruning build need to know, and `report` and `compare` read files `DOWNTRACE_INSPECT` wrote.
 *
 * Everything it reads from the process it runs in is read here, once, and handed on; the rest of it only returns
 * a status. A signal stops the runs, takes the temporary worktree away and ends with the status that says no
 * comparison was made.
 *
 * On a Node below the floor it says so in one line and ends with 2, before it loads anything that could fail there
 * with a stack trace instead (DT-131): the rest of the command is imported after the check.
 */
const unsupported = unsupportedNode(process.versions.node);
if (unsupported !== undefined) {
  process.stderr.write(`downtrace: ${unsupported}\n`);
  process.exitCode = 2;
} else {
  const { runCli } = await import("./check/command.ts");
  const { AGENT_VERSION } = await import("./version.ts");
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());

  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    tmpRoot: tmpdir(),
    // The package's own `register` entry, wherever it is installed: `src/register.ts` here, `dist/register.js` published.
    registerUrl: import.meta.resolve("@downtrace/agent/register"),
    version: AGENT_VERSION,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    signal: abort.signal,
  });
}
