import { parseConfig } from "../check/config.ts";
import { REGISTER_SPECIFIER } from "./detect.ts";

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
