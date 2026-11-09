#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { unsupportedNode } from "./node-floor.ts";

/**
 * `downtrace`: the command of this package. `check` compares two runs of the project's tests before a deploy, `init`
 * writes what `check` and a pruning build need to know, and `report` and `compare` read files `DOWNTRACE_INSPECT` wrote.
 * `login` connects a coding agent to a cloud, and `brief` and `api` read it with the credential login stored.
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
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
  const io = {
    env: process.env,
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
    signal: abort.signal,
  };
  const [command, ...words] = process.argv.slice(2);
  if (command === "login") {
    // `login`, `brief` and `api` speak to a cloud with the user's credentials file, which none of the others reads.
    const { runLogin } = await import("./login/command.ts");
    process.exitCode = await runLogin({ ...io, argv: words, home: homedir(), uid: process.getuid?.() });
  } else if (command === "brief" || command === "api") {
    const { runRead } = await import("./read.ts");
    const { defaultNow } = await import("./clock.ts");
    process.exitCode = await runRead({
      ...io,
      command,
      argv: words,
      home: homedir(),
      uid: process.getuid?.(),
      now: defaultNow,
    });
  } else {
    const { runCli } = await import("./check/command.ts");
    const { AGENT_VERSION } = await import("./version.ts");

    process.exitCode = await runCli({
      ...io,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      tmpRoot: tmpdir(),
      // The package's own `register` entry, wherever it is installed: `src/register.ts` here, `dist/register.js`
      // published. Found as `require` finds it, which every supported Node can: Node 20 has `import.meta.resolve`
      // without a flag only from 20.6, and before it every command ended in a stack trace (DT-142).
      registerUrl: pathToFileURL(createRequire(import.meta.url).resolve("@downtrace/agent/register")).href,
      version: AGENT_VERSION,
    });
  }
}
