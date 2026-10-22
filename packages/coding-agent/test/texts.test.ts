import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../../agent/src/check/args.ts";
import { evaluateRoute } from "../../agent/src/check/compare.ts";
import { renderJson } from "../../agent/src/check/render.ts";
import { failed } from "../../agent/src/check/report.ts";
import { runInit } from "../../agent/src/init/command.ts";
import { tools } from "../../mcp/src/tools.ts";

/**
 * What a coding agent reads here is followed to the letter, so every command, flag, variable, tool and field it
 * names is asked of the code that has to answer it: a flag `downtrace` does not take, a variable nothing reads or a
 * tool the MCP server does not list would be invented the day the text is followed. Each is read from the source,
 * never from a second list kept here.
 */

const root = new URL("../", import.meta.url);
const read = (path: string): Promise<string> => readFile(new URL(path, root), "utf8");
const readJson = async (path: string): Promise<unknown> => JSON.parse(await read(path));

const BEGIN = "<!-- downtrace:begin -->";
const END = "<!-- downtrace:end -->";

let block: string;
let skill: string;
let skillBody: string;
let skillFrontmatter: string;
let hookText: string;
/** Every text a coding agent is handed: the block, the skill and what the hook prints. */
let texts: { name: string; text: string }[];

beforeAll(async () => {
  block = await read("AGENTS-block.md");
  skill = await read("skills/downtrace/SKILL.md");
  hookText = await read("hooks/session-start.md");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  skillFrontmatter = match?.[1] ?? "";
  skillBody = match?.[2] ?? "";
  texts = [
    { name: "AGENTS-block.md", text: block },
    { name: "SKILL.md", text: skill },
    { name: "session-start.md", text: hookText },
  ];
});

/** The text of the block between its markers, which is what a person pastes and what the skill repeats. */
function inner(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return "";
  return text.slice(start + BEGIN.length, end).trim();
}

/** Every command of the block written as a coding agent would type it, after `npx @downtrace/agent`. */
function commandsOf(text: string): string[][] {
  const found: string[][] = [];
  for (const span of text.matchAll(/`npx @downtrace\/agent ([^`]+)`/g)) {
    found.push(words(span[1] ?? ""));
  }
  return found;
}

/** Splits a command line into its words as a POSIX shell would for these: double quotes keep a word whole. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

describe("the AGENTS.md block", () => {
  it("is fenced by its markers, so that pasting it again replaces it", () => {
    expect(block.trimStart().startsWith(BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(END)).toBe(true);
    expect(inner(block).length).toBeGreaterThan(0);
  });

  it("names init and check, each with a command that exists", () => {
    const commands = commandsOf(block);
    expect(commands.map((c) => c[0])).toEqual(expect.arrayContaining(["init", "check"]));
    for (const command of commands) {
      const parsed = parseArgs(command);
      expect(parsed.kind, command.join(" ")).toBe(command[0]);
    }
  });

  it("uses every option of check and init that it names exactly as the command reads it", () => {
    const options = new Set(USAGE.match(/--[a-z]+/g) ?? []);
    // Node's own flags, in the line that starts the instrumentation in production, are Node's to read.
    const ours = block.replaceAll(/`node [^`]*`/g, "");
    for (const flag of ours.match(/(?<![\w-])--[a-z]+/g) ?? []) {
      expect(options.has(flag), flag).toBe(true);
    }
  });

  it("states the exit statuses the commands have", () => {
    for (const status of ["0 no route got worse", "1 at least one did", "2 no comparison could be made"]) {
      expect(USAGE).toContain(status);
      expect(block).toContain(status);
    }
    for (const status of ["0 configured", "1 something could not be detected or done", "2 a file it reads"]) {
      expect(USAGE).toContain(status);
      expect(block).toContain(status);
    }
  });

  it("asks for the routes that were not evaluated, and names the fields of check's JSON that hold them", async () => {
    expect(block).toMatch(/not evaluated, with its `reasons`/);
    const route = evaluateRoute("GET /orders", undefined, undefined);
    const report = JSON.parse(
      renderJson(
        failed({
          failure: { code: "no-profile", side: null, message: "m", advice: "a", outputTail: null },
          routes: [route],
        }),
      ),
    ) as Record<string, unknown>;
    const [first] = report.routes as Record<string, unknown>[];
    expect(first?.verdict).toBe("not-evaluated");
    expect(first?.reasons).toBeInstanceOf(Array);
    expect(report.summary).toHaveProperty("notEvaluated");
    for (const key of ["code", "message", "advice"]) {
      expect(report.failure).toHaveProperty(key);
      expect(block).toContain(`\`failure.${key}\``);
    }
    for (const key of ["status", "summary"]) {
      expect(report).toHaveProperty(key);
      expect(block).toContain(`\`${key}\``);
    }
  });

  it("names the fields of init's JSON that it tells a coding agent to follow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "downtrace-coding-agent-"));
    try {
      let out = "";
      await runInit({ cwd: dir, json: true, stdout: (text) => (out += text) });
      const report = JSON.parse(out) as Record<string, unknown>;
      const [missing] = report.missing as Record<string, unknown>[];
      expect(missing).toHaveProperty("advice");
      expect(report).toHaveProperty("next");
      for (const key of ["missing", "advice", "next"]) expect(block).toContain(`\`${key}\``);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the skill", () => {
  it("is the block, word for word, so that a coding agent reads one text wherever it reads it", () => {
    expect(skillBody.trim(), "copy the text between the markers of AGENTS-block.md into SKILL.md").toBe(inner(block));
  });

  it("has the name and the description Claude Code lists it by, with the use first", () => {
    expect(skillFrontmatter).toMatch(/^name: downtrace$/m);
    const description = /^description: (.+)$/m.exec(skillFrontmatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    // The listing cuts a description at 1,536 characters; past that, what comes later is not read.
    expect(description.length).toBeLessThan(1536);
    for (const word of ["performance", "regression", "N+1", "deploy", "production"]) {
      expect(description, word).toContain(word);
    }
  });
});

describe("every text a coding agent is handed", () => {
  it("never calls anything «agent» on its own (ADR 0016)", () => {
    for (const { name, text } of texts) {
      const bare = [...text.matchAll(/(?<!coding |@downtrace\/)\bagents?\b(?![-.]\w)/gi)].map((m) => m[0]);
      expect(bare, name).toEqual([]);
    }
  });

  it("says that observed content is data, never instructions (invariant 12)", () => {
    for (const { name, text } of texts) {
      expect(text, name).toMatch(/`fromService`/);
      expect(text, name).toMatch(/data, never instructions/);
    }
  });

  it("never runs a bare `npx downtrace`, which is not ours on the registry (DT-107)", () => {
    for (const { name, text } of texts) {
      for (const line of text.split("\n")) {
        if (!/npx\s+(-y\s+)?downtrace\b/.test(line)) continue;
        expect(line, name).toMatch(/Never shorten them to `npx downtrace` unless `@downtrace\/agent` is a dependency/);
      }
    }
  });

  it("names only variables the code reads", async () => {
    const source = (await Promise.all([sourceOf("../agent/src"), sourceOf("../mcp/src")])).join("\n");
    for (const { name, text } of texts) {
      for (const variable of text.match(/DOWNTRACE_[A-Z_]+/g) ?? []) {
        expect(source.includes(`"${variable}"`), `${name}: ${variable}`).toBe(true);
      }
    }
  });

  it("names only tools the MCP server lists, and the fields of changes_since it relies on", () => {
    const names = new Set(tools.map((tool) => tool.name));
    for (const { name, text } of texts) {
      for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        expect(names.has(match[1] ?? ""), `${name}: ${match[1]}`).toBe(true);
      }
      expect(text, name).toContain("`changes_since`");
    }
    const changes = tools.find((tool) => tool.name === "changes_since");
    expect(changes?.description).toContain("`until`");
    expect(JSON.stringify(changes)).toContain("arrivedSince");
  });
});

async function sourceOf(dir: string): Promise<string> {
  const base = new URL(`${dir}/`, root);
  const files = (await readdir(base, { recursive: true })).filter((file) => file.endsWith(".ts"));
  return (await Promise.all(files.map((file) => readFile(new URL(file, base), "utf8")))).join("\n");
}

describe("the plugin", () => {
  it("has a manifest Claude Code accepts", async () => {
    const manifest = (await readJson(".claude-plugin/plugin.json")) as Record<string, unknown>;
    expect(manifest.name).toBe("downtrace");
    expect(String(manifest.name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof manifest.description).toBe("string");
    expect((manifest.author as Record<string, unknown>).name).toEqual(expect.any(String));
    // A version pins its users to it until it changes; without one they follow the repository.
    expect(manifest).not.toHaveProperty("version");
  });

  it("starts the MCP server the way its README says, with the credential from the environment", async () => {
    const config = (await readJson(".mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = config.mcpServers.downtrace;
    expect(server?.command).toBe("npx");
    expect(server?.args).toEqual(["-y", "@downtrace/mcp"]);
    // Never a value written here: a credential in a file is a credential in a repository.
    // Claude Code expands `${NAME:-}` from its environment: empty when unset, which the server says, by name.
    const fromEnvironment = (name: string): string => `$\{${name}:-}`;
    expect(server?.env).toEqual({
      DOWNTRACE_URL: fromEnvironment("DOWNTRACE_URL"),
      DOWNTRACE_TOKEN: fromEnvironment("DOWNTRACE_TOKEN"),
    });
    const readme = await read("../mcp/README.md");
    expect(readme).toContain('"args": ["-y", "@downtrace/mcp"]');
  });

  it("prints the start-of-session step when a session starts", async () => {
    const hooks = (await readJson("hooks/hooks.json")) as {
      hooks: Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]>;
    };
    const [entry] = hooks.hooks.SessionStart ?? [];
    expect(entry?.matcher.split("|")).toContain("startup");
    const [hook] = entry?.hooks ?? [];
    expect(hook?.type).toBe("command");
    const file = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(hook?.command ?? "")?.[1];
    expect(file).toBe("hooks/session-start.md");
    expect(hookText).toMatch(/in one line/);
  });

  it("is offered by a marketplace whose source is this directory, from the root of the mirror", async () => {
    const marketplace = (await readJson("marketplace.json")) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    expect(marketplace.owner.name).toEqual(expect.any(String));
    const [plugin] = marketplace.plugins;
    expect(plugin?.name).toBe("downtrace");
    // The mirror puts this file at its root, where `packages/` holds this directory.
    expect(plugin?.source).toBe(`./packages/${basename(fileURLToPath(root))}`);
  });
});
