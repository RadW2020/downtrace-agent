#!/usr/bin/env node
import { tmpdir } from "node:os";
import { runCli } from "./check/command.ts";
import { AGENT_VERSION } from "./version.ts";

/**
 * `downtrace`: the command of this package. It has two subcommands: `check`, which compares two runs of the
 * project's tests before a deploy, and `init`, which writes what `check` and a pruning build need to know.
 *
 * Everything it reads from the process it runs in is read here, once, and handed on; the rest of it only returns
 * a status. A signal stops the runs, takes the temporary worktree away and ends with the status that says no
 * comparison was made.
 */
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
