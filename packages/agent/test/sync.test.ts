import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/**
 * Every source file, read from the directory and not from a list, **and from every directory under it** —
 * the same reading as the clock guard (ADR 0152), whose first version read `src/` and not `src/instrument/`:
 * a list written by hand only checks the files somebody remembered to put in it, and the file that breaks
 * this rule next is the one added after it.
 */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/**
 * Code only, with the line numbers kept: a comment is blanked, not deleted, so a finding points at the line
 * it is on. Deleting the comment's newlines would move every line after it, and a guard that names a line it
 * has not read is a guard that has not read the file.
 */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/gm, (match, lead) =>
    lead === undefined ? match.replace(/[^\n]/g, " ") : lead + match.slice(lead.length).replace(/[^\n]/g, " "),
  );
}

/**
 * The identifier of a synchronous function, a call or a reference: `fs.readFileSync(path)`, `execSync(cmd)`,
 * `spawnSync(cmd, args)`, `import { readFileSync } from "node:fs"`, and the reference
 * `const read = fs.readFileSync`, which runs the I/O later — a reference is a call the guard would not see
 * written, and the clock guard learned that the hard way (ADR 0152).
 *
 * The convention that names a function `*Sync` is the one that says it blocks, so a homegrown name of the
 * convention is a finding too: in a library whose whole point is not to block, `flushSync` declares that it
 * will. A lowercase `sync` is not the convention: `queue.sync()` awaits, and the guard leaves it alone.
 */
const SYNC = /\b[A-Za-z_$][A-Za-z0-9_$]*Sync\b/;

/**
 * `Atomics.wait`, a call or a reference: it is not I/O, it is a wait — but the wait that stops the thread,
 * and with it the event loop, which in the path of a request is the blocking invariant 1 forbids. The other
 * `Atomics` operations (`load`, `store`, `add`, ...) do not wait, and they are left alone.
 */
const WAIT = /\bAtomics\.wait\b/;

/**
 * The decisions this guard has been given: a synchronous call the start-up needs, the one file it may be
 * written in, and why. An allowance excuses that name in that file and nothing else — another `*Sync` beside
 * it is still a finding, and so is the same name in any other file — and an allowance nothing uses any more is
 * a finding too, so that none outlives its reason.
 *
 * - `realpathSync`, in `entry.ts` (DT-34). Node runs the main module from its realpath, and `pg` and Express
 *   have to be resolved from the same place: from the symlinked binary a process may be started through,
 *   nothing of the application resolves. It has to happen at start-up, before the application registers
 *   anything, because a mount registered before Express is armed cannot be read after — there is no later
 *   moment, and no promise to wait for. It runs once per process, from `Agent.start()`, never in a request:
 *   invariant 1 is about the path of a request, and this is not in it. Nor is it the start-up's first
 *   synchronous I/O: resolving `pg` and loading Express go through the module loader, which reads the disk
 *   synchronously under names this guard cannot see.
 */
const ALLOWED: ReadonlyArray<{ file: string; name: string }> = [{ file: "entry.ts", name: "realpathSync" }];

/** Every name of the convention on a line, where `SYNC` stops at the first. */
const SYNC_ALL = new RegExp(SYNC.source, "g");

/**
 * The lines of a piece of code that carry a finding, numbered from one as they are in the file. `allowed` is
 * what `ALLOWED` gives the file the code comes from, and nothing by default.
 */
function offendingLines(code: string, allowed: readonly string[] = []): string[] {
  const lines: string[] = [];
  code.split("\n").forEach((line, index) => {
    const blocking = (line.match(SYNC_ALL) ?? []).some((name) => !allowed.includes(name));
    if (blocking || WAIT.test(line)) lines.push(`${index + 1}: ${line.trim()}`);
  });
  return lines;
}

function allowedIn(file: string): string[] {
  return ALLOWED.filter((allowance) => allowance.file === file).map((allowance) => allowance.name);
}

function findings(): string[] {
  const all: string[] = [];
  for (const file of sources()) {
    const code = codeOf(readFileSync(join(SRC, file), "utf8"));
    for (const line of offendingLines(code, allowedIn(file))) all.push(`${file} ${line}`);
  }
  return all;
}

describe("synchronous I/O in the agent", () => {
  it("has sources to check", () => {
    // A rule that reads nothing passes for the wrong reason.
    expect(sources().length).toBeGreaterThan(10);
  });

  it("reads every directory of the source, not only the first", () => {
    const read = new Set(sources().map((file) => dirname(file)));
    const directories = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(entry.parentPath, entry.name).slice(SRC.length));
    expect(directories.length, "there is a subdirectory to read, or this says nothing").toBeGreaterThan(0);
    for (const directory of directories) expect(read, `${directory} was never read`).toContain(directory);
  });

  // Invariant 1: «The instrumentation never performs synchronous I/O nor waits for the cloud inside the path
  // of a request». The guard reads that path as the **whole of src/**: which line is in the path of a request
  // is not something a test that reads files can decide — the sender is built at start-up and flushed from a
  // request, `agent.ts` holds both, and a file that is start-up today is shared with the request path tomorrow
  // — and the start-up performs no synchronous I/O of its own but the calls in `ALLOWED`: it reads the
  // environment, a hostname and a uuid, resolves the application's entry, and wires the components. The rule
  // is stricter than the invariant and simpler to keep; if the start-up ever needs another `readFileSync`,
  // this test is discussed, not weakened — and what the discussion decided goes in `ALLOWED`, with its reason.
  it("performs no synchronous I/O and stops no thread, anywhere in the source", () => {
    expect(
      findings(),
      "these stop the event loop. In the path of a request that is invariant 1; in the start-up it is a " +
        "decision this guard has not been given. If the start-up really needs one, the test is discussed, " +
        "never weakened.",
    ).toEqual([]);
  });

  // The rule shown failing: a guard nobody has seen go red is one nobody knows can (ADR 0152).
  it.each([
    ["a read", 'const data = fs.readFileSync(path, "utf8");'],
    ["a write, the inspection mode's file", "fs.appendFileSync(file, line);"],
    ["a child process", "const out = execSync(command);"],
    ["a spawned child process", "const result = spawnSync(command, args);"],
    ["an import of one", 'import { readFileSync } from "node:fs";'],
    ["a reference handed over", "const read = fs.readFileSync;"],
    ["a homegrown name of the same convention", "function flushSync() { write(fd, buffer); }"],
    ["a blocking wait", "Atomics.wait(shared, 0, 0);"],
    ["a realpath in a file that was not allowed one", "return realpathSync(given);"],
  ])("sees the blocking form %s", (_what, text) => {
    expect(offendingLines(codeOf(text))).not.toEqual([]);
  });

  it.each([
    ["a promise", "const data = await fs.promises.readFile(path);"],
    ["the write the inspection mode does", "await appendFile(file, line);"],
    ["a duration", "const started = performance.now();"],
    ["an Atomics operation that does not wait", "Atomics.add(shared, 0, 1);"],
    ["a lowercase sync", "await queue.sync();"],
    ["a comment", "// readFileSync would stop the request\nconst data = await read(path);"],
    ["a block comment", "/** Not an Atomics.wait, only a load. */\nconst flag = Atomics.load(shared, 0);"],
  ])("does not mistake %s for one", (_what, text) => {
    expect(offendingLines(codeOf(text))).toEqual([]);
  });

  it("excuses an allowed name and nothing beside it", () => {
    expect(offendingLines(codeOf("return realpathSync(given);"), ["realpathSync"])).toEqual([]);
    expect(offendingLines(codeOf("realpathSync(a); readFileSync(b);"), ["realpathSync"])).toEqual([
      "1: realpathSync(a); readFileSync(b);",
    ]);
    expect(offendingLines(codeOf("Atomics.wait(shared, 0, 0);"), ["realpathSync"])).not.toEqual([]);
  });

  it("keeps no allowance its file no longer uses", () => {
    for (const { file, name } of ALLOWED) {
      expect(sources(), `${file} is not in the source`).toContain(file);
      const code = codeOf(readFileSync(join(SRC, file), "utf8"));
      expect(code.match(SYNC_ALL) ?? [], `${file} no longer uses ${name}: remove the allowance`).toContain(name);
    }
  });

  it("points at the line it found it on", () => {
    expect(offendingLines(codeOf("const a = 1;\nfs.appendFileSync(file, line);"))).toEqual([
      "2: fs.appendFileSync(file, line);",
    ]);
  });
});
