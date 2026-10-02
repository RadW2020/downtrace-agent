import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Whether Node keeps the main module's symlinks: `--preserve-symlinks-main`, on the command line or in
 * `NODE_OPTIONS` (DT-34).
 *
 * Read the way Node reads it: `NODE_OPTIONS` first and the command line after it, so the command line wins;
 * the last spelling wins; `--no-` turns it off; an underscore is a dash; and what follows an `=` is not read —
 * `--preserve-symlinks-main=false` turns it on. `--preserve-symlinks` does not count: Node says it does not
 * apply to the main module. The test checks each of these against Node itself.
 */
export function preservesSymlinksMain(execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  let preserve = false;
  for (const arg of [...nodeOptionsArgs(nodeOptions ?? ""), ...execArgv]) {
    const name = (arg.split("=", 1)[0] ?? "").replaceAll("_", "-");
    if (name === "--preserve-symlinks-main") preserve = true;
    else if (name === "--no-preserve-symlinks-main") preserve = false;
  }
  return preserve;
}

/**
 * `NODE_OPTIONS` split into arguments as Node splits it: at a space outside double quotes, with the quotes
 * removed and a backslash inside them escaping the next character. Node refuses to start on a value it cannot
 * split, so a process that is running has none of those.
 */
function nodeOptionsArgs(value: string): string[] {
  const args: string[] = [];
  let quoted = false;
  let current: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    let c = value.charAt(i);
    if (c === "\\" && quoted) {
      i += 1;
      c = value.charAt(i);
    } else if (c === " " && !quoted) {
      if (current !== undefined) args.push(current);
      current = undefined;
      continue;
    } else if (c === '"') {
      quoted = !quoted;
      current ??= "";
      continue;
    }
    current = (current ?? "") + c;
  }
  if (current !== undefined) args.push(current);
  return args;
}

export interface EntryOptions {
  /** `--preserve-symlinks-main`, as `preservesSymlinksMain` read it. Absent is Node's default: the symlinks are resolved. */
  preserveSymlinksMain?: boolean | undefined;
  /** The process's arguments; `process.argv` unless a test says otherwise. */
  argv?: readonly string[] | undefined;
}

/**
 * The path the application's own dependencies resolve from: its main module, where Node runs it (DT-34), or the
 * directory Node found the main module in (DT-48).
 *
 * Node runs the main module from its realpath, unless `--preserve-symlinks-main` keeps the path as given, and
 * resolves the application's imports from there. `process.argv[1]` is the path as given: through a symlinked
 * binary — `npm i -g`, `/usr/local/bin/<app>` — it is the link, in a directory from which nothing of the
 * application resolves. So `pg` and Express are resolved from what this returns, and not from `argv[1]`.
 *
 * With `node .` or `node <directory>` — `CMD ["node", "."]` — `argv[1]` is the directory, and Node runs the
 * `main` of its `package.json`, or its `index`. `createRequire` reads a path without a trailing separator as a
 * file and resolves from its parent, where nothing of the application is; so a directory is returned with the
 * separator, and resolution starts inside it, where the main module is. The `main` is not looked up: what
 * decides what resolves is where the search for `node_modules` starts, and it starts in the same directory. The
 * two layouts where it does not — a `main` that is a symlink out of the directory, or one with a `node_modules`
 * of its own between it and the directory — resolve from the directory. The test asks Node which `pg` the
 * application loads, and this has to resolve the same one.
 *
 * Synchronous on purpose, and the two synchronous calls of the source, which the I/O guard allows by name and
 * with this reason: it runs at start-up, before the application registers anything, because a mount registered
 * before Express is armed cannot be read after (`armMounts`) — there is no later moment to wait for. Once per
 * process, from `Agent.start()`, never in a request (invariant 1).
 *
 * It cannot throw (invariant 2): an entry whose realpath cannot be read — it does not exist, or a link loops —
 * is the path as given, which is what was resolved from before; one that cannot be read as a directory is not
 * one; and without a script, the working directory.
 */
export function applicationEntry(options: EntryOptions = {}): string {
  let given: string;
  try {
    const main = (options.argv ?? process.argv)[1];
    // Without a script — a REPL, `-e` with nothing after it — the working directory, as before.
    if (main === undefined) return `${process.cwd()}/`;
    // Absolute, as Node makes it before it resolves the main module; `createRequire` refuses a relative path.
    given = path.resolve(main);
  } catch {
    // Not even a working directory to make a path absolute with: it was removed under the process. The root
    // resolves nothing of the application, so the observers say `unavailable`, and the start goes on.
    return "/";
  }
  let entry = given;
  if (options.preserveSymlinksMain !== true) {
    try {
      entry = realpathSync(given);
    } catch {
      // Nothing to resolve the link with: the path as given is the base, and from it the application's modules
      // resolve as they did before, or do not — the observers then say `unavailable`, never a throw.
      entry = given;
    }
  }
  try {
    // A directory ends in its separator, so that `createRequire` starts inside it and not in its parent. The
    // root already does, and two would say the same thing less plainly.
    if (statSync(entry, { throwIfNoEntry: false })?.isDirectory() === true && !entry.endsWith(path.sep)) {
      return `${entry}${path.sep}`;
    }
  } catch {
    // What cannot be read as a directory is not one to start inside: the base stays as it is, as above.
    return entry;
  }
  return entry;
}
