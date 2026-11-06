import { parseConfig } from "../check/config.ts";
import { AGENT_PACKAGE, REGISTER_SPECIFIER } from "./detect.ts";

/**
 * What `downtrace init` writes: the test command into `downtrace.json`, where `check` reads it, and the
 * instrumentation hook a Next.js build with `output: "standalone"` needs. Pure: the files are read and written
 * by whoever calls these.
 */

/**
 * The hook, as the README gives it. Next runs `register` once before it serves anything, and the import is what
 * makes a build that prunes ship the package. Next calls it in every runtime it builds for, the edge runtime of a
 * `middleware.ts` included, and the edge runtime cannot load Node's own modules: without the condition, a project
 * with a middleware does not build (checked on Next 15.5).
 */
export const REGISTER_FUNCTION = `export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("${REGISTER_SPECIFIER}");
  }
}
`;

/** The file `init` writes: the hook, and a line that says what it is for. */
export const INSTRUMENTATION_FILE = `// Loads the Downtrace instrumentation before Next.js serves anything, and makes a build with output: "standalone"
// ship it. Written by \`downtrace init\`; see the README of @downtrace/agent.
${REGISTER_FUNCTION}`;

/**
 * The instrument file, as `init` writes it (RF-106): the instrumentation started from the application's code, by the
 * first thing the application loads. `init` knows no DSN and asks for none, so the file reads `DOWNTRACE_DSN`, and
 * without one does nothing: a DSN written in place of it sends from every machine that runs the code, a developer's
 * included, and that is the person's to decide.
 */
export function instrumentFile(language: "commonjs" | "typescript" | "esm"): string {
  const how = language === "esm" ? "with node --import ./instrument.mjs" : "by the first line of the entry";
  const load =
    language === "commonjs"
      ? `const { init } = require("${AGENT_PACKAGE}");`
      : `import { init } from "${AGENT_PACKAGE}";`;
  return `// Starts the Downtrace instrumentation before the application loads anything else, ${how}.
// Written by \`downtrace init\`; see the README of ${AGENT_PACKAGE}. Without a DSN it does nothing: set
// DOWNTRACE_DSN where the application runs, or write the DSN here in its place.
${load}

init({ dsn: process.env.DOWNTRACE_DSN });
`;
}

/** The line that loads the instrument file from the entry beside it. */
export function loadingLine(language: "commonjs" | "typescript"): string {
  return language === "commonjs" ? 'require("./instrument");' : 'import "./instrument";';
}

/** The flag that loads the instrument file of an ES module application, before its entry. */
export const IMPORT_FLAG = "--import ./instrument.mjs";

/** Whether the text of an entry loads the instrument file beside it already, however it is spelled. */
export function loadsInstrument(text: string): boolean {
  return /(?:\brequire\(\s*|\bimport\s*|\bfrom\s*)(["'])\.\/instrument(?:\.[cm]?[jt]s)?\1/.test(text);
}

/**
 * The entry with `line` as its first statement. A shebang, the comments before the code and the directive prologue
 * (`"use strict"`) stay before it: a directive after a statement is not one, and the file would leave strict mode.
 */
export function withFirstLine(text: string, line: string): string {
  const lines = text.split("\n");
  let at = lines[0]?.startsWith("#!") ? 1 : 0;
  for (let comment = false; at < lines.length; at += 1) {
    const current = (lines[at] ?? "").trim();
    if (comment) {
      if (current.includes("*/")) comment = false;
    } else if (current.startsWith("/*")) {
      comment = !current.includes("*/");
    } else if (current !== "" && !current.startsWith("//") && !/^(["'])use strict\1;?$/.test(current)) {
      break;
    }
  }
  lines.splice(at, 0, line);
  return lines.join("\n");
}

/** A start script with `--import ./instrument.mjs` after its `node`, or undefined when it does not start with `node`. */
export function withImportFlag(script: string): string | undefined {
  const node = /^\s*node(?=\s)/.exec(script);
  if (node === null) return undefined;
  return `${node[0]} ${IMPORT_FLAG}${script.slice(node[0].length)}`;
}

/**
 * `package.json` with one script changed and every other byte as it was, or undefined when the script is not written
 * the way JSON.stringify would write it, and so cannot be found for sure.
 */
export function withScript(text: string, name: string, from: string, to: string): string | undefined {
  const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const key = new RegExp(`(${literal(JSON.stringify(name))}\\s*:\\s*)${literal(JSON.stringify(from))}`);
  if (!key.test(text)) return undefined;
  return text.replace(key, (_match, before: string) => `${before}${JSON.stringify(to)}`);
}

/** What to do with `downtrace.json`. */
export type ConfigPlan =
  /** There is none, and there is a command to write: a new file. */
  | { kind: "create"; text: string; command: string }
  /** There is one with no command: the command is added, and everything else in it is kept. */
  | { kind: "update"; text: string; command: string }
  /** There is one with a command: it is the person's, and it stays. */
  | { kind: "keep"; command: string }
  /** There is no command to write, and none in a file. */
  | { kind: "none" }
  /** There is one that `check` would refuse: it is not rewritten, and the reason is said. */
  | { kind: "refuse"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * What `downtrace.json` becomes, from what it holds (undefined when there is none) and the test command found.
 * A command already there wins over the one found, because a person put it there; a key `init` does not write
 * is kept where it is, inside `check` or outside it.
 */
export function planConfig(existing: string | undefined, command: string | undefined, source: string): ConfigPlan {
  if (existing === undefined) {
    return command === undefined ? { kind: "none" } : { kind: "create", text: asText({ check: { command } }), command };
  }
  const parsed = parseConfig(existing, source);
  if (!parsed.ok) return { kind: "refuse", reason: parsed.reason };
  if (parsed.config.command !== undefined) return { kind: "keep", command: parsed.config.command };
  if (command === undefined) return { kind: "none" };

  const value: unknown = JSON.parse(existing);
  // `parseConfig` read it as an object whose `check`, when there is one, is an object too.
  if (!isRecord(value)) return { kind: "refuse", reason: `${source}: it must be a JSON object` };
  const check = isRecord(value.check) ? value.check : {};
  value.check = { command, ...check };
  return { kind: "update", text: asText(value), command };
}
