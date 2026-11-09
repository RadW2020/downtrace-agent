import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../../agent/src/check/args.ts";
import { evaluateRoute, type OperationResult } from "../../agent/src/check/compare.ts";
import { feedbackFor } from "../../agent/src/check/feedback.ts";
import { renderJson } from "../../agent/src/check/render.ts";
import { failed } from "../../agent/src/check/report.ts";
import { runInit } from "../../agent/src/init/command.ts";
import { parseReadArgs } from "../../agent/src/read.ts";
import { parseStampArgs } from "../../agent/src/stamp.ts";
import { tools } from "../../mcp/src/tools.ts";

/**
 * What a coding agent reads here is followed to the letter, so every command, flag, variable, tool and field it
 * names is asked of the code that has to answer it: a flag `downtrace` does not take, a variable nothing reads or a
 * tool the MCP server does not list would be invented the day the text is followed. Each is read from the source,
 * never from a second list kept here.
 *
 * The source is not what a coding agent runs, though: the mirror publishes this directory on every push, and npx
 * fetches what npm serves, which is the source as it was at the last release. So the texts run the versions released
 * with them, and what those versions take is asked too, of `released.json`, which the versions PR writes from the
 * source it releases.
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

/** Every command of the block written as a coding agent would type it, after `npx @downtrace/agent@<version>`. */
function commandsOf(text: string): string[][] {
  const found: string[][] = [];
  for (const span of text.matchAll(/`npx @downtrace\/agent(?:@[^\s`]+)? ([^`]+)`/g)) {
    found.push(words(span[1] ?? ""));
  }
  return found;
}

/** Every `npx @downtrace/agent` of a text, quoted or not, with the version it names, or undefined if it names none. */
function versionsOf(text: string): { written: string; version: string | undefined }[] {
  return [...text.matchAll(/npx @downtrace\/agent(?:@([^\s`)]+))?/g)].map((m) => ({ written: m[0], version: m[1] }));
}

/** Splits a command line into its words as a POSIX shell would for these: double quotes keep a word whole. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

/**
 * A command read by the parser `cli.ts` hands it to: `brief` and `api` by `read.ts`'s, `stamp` by its own, the rest
 * by `check/args.ts`'s. What it gives is the kind the command runs as, or `error` with the reason it refuses.
 */
function parse(command: string[]): { kind: string; message?: string } {
  const [name, ...rest] = command;
  if (name === "brief" || name === "api") return parseReadArgs(name, rest);
  if (name === "stamp") return parseStampArgs(rest);
  return parseArgs(command);
}

/** The kind each command runs as, where its parser does not name it after the command. */
const RUNS_AS: Record<string, string> = { brief: "read", api: "read" };

/** The numbered rule of a text, from its number to the next one. */
function rule(text: string, n: number): string {
  return new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |^<!--|(?![\\s\\S]))`, "m").exec(text)?.[0] ?? "";
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
      const parsed = parse(command);
      const name = command[0] ?? "";
      expect(parsed.kind, `${command.join(" ")}: ${parsed.message ?? ""}`).toBe(RUNS_AS[name] ?? name);
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
    for (const status of ["0 read", "1 the cloud refused", "2 nothing could be read"]) {
      expect(USAGE).toContain(status);
      expect(block).toContain(status);
    }
    for (const status of ["0 nothing got worse", "1 something did", "2 no verdict"]) {
      expect(USAGE).toContain(status);
      expect(block).toContain(status);
    }
  });

  it("asks, of each route that got worse, where the change runs what made it worse: check's `sites`", () => {
    // covers: RF-526
    // A field `check` writes on an operation that got worse; renamed there, this stops compiling (`make typecheck`).
    const field: keyof OperationResult = "sites";
    expect(rule(block, 1)).toContain(`\`${field}\``);
    expect(rule(block, 1)).toContain("`file:line`");
  });

  it("reads the brief from the shell where the MCP server is not there, and each path it names", () => {
    // covers: RF-523
    const commands = commandsOf(block).map((command) => command.join(" "));
    expect(commands).toContain("brief --json");
    expect(commands.some((command) => command.startsWith("api "))).toBe(true);
    expect(rule(block, 5)).toContain("`brief --json`");
    expect(block).toContain("`next.api`");
  });

  it("waits for a deploy's verdict in the background, and proposes stamp, never running it unasked", () => {
    const commands = commandsOf(block);
    const deploy = commands.find((command) => command[0] === "brief" && command.includes("--deploy"));
    expect(deploy, "a brief --deploy").toBeDefined();
    expect(deploy).toEqual(expect.arrayContaining(["--wait", "--json"]));
    expect(block).toMatch(/in the background/);
    expect(commands.map((command) => command[0])).toContain("stamp");
    expect(rule(block, 7)).toMatch(/`stamp`[^.]*: propose it[^.]*never/);
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

  it("names the fields of the feedback check's JSON offers, which the report has, and says it is never sent", () => {
    const report = failed({
      failure: { code: "no-profile", side: "base", message: "the run left no profile", advice: null, outputTail: null },
    });
    expect(report).toHaveProperty("feedback");
    const feedback = feedbackFor(report, {
      version: "0",
      node: "v22",
      platform: "linux",
      dependencies: new Set(),
      command: "npm test",
      scripts: {},
    });
    for (const key of ["why", "url"]) {
      expect(feedback).toHaveProperty(key);
      expect(block).toContain(`\`feedback.${key}\``);
    }
    expect(block).toContain("never submit it for them");
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

  it("starts a session at the brief, says in one line what it found, and when no telemetry arrived", () => {
    // covers: RF-523
    for (const { name, text } of [
      { name: "rule 5 of AGENTS-block.md", text: rule(block, 5) },
      { name: "rule 5 of SKILL.md", text: rule(skillBody, 5) },
      { name: "session-start.md", text: hookText },
    ]) {
      expect(text, name).toMatch(/When a session starts|when a session starts|before the first task/);
      expect(text, name).toContain("`project_brief`");
      // The slug the tool takes, named by the credential when the coding agent does not know it.
      expect(text, name).toMatch(/`read_credential` names it/);
      expect(text, name).toMatch(/in one line what it found/);
      expect(text, name).toContain("`telemetry.arrivedSince` is false");
      expect(text, name).toMatch(/no telemetry arrived, never that there is nothing to report/);
      // The brief first; what changed since the last look after it, from an `until`.
      expect(text.indexOf("`changes_since`"), name).toBeGreaterThan(text.indexOf("`project_brief`"));
      expect(text, name).toMatch(/`changes_since`[^.]*`until`|`until`[^.]*`changes_since`/);
    }
    for (const { name, text } of texts) {
      for (const said of text.matchAll(/[^.]*\bnothing (?:to report|changed)\b[^.]*/g)) {
        expect(said[0], name).toMatch(/never that/);
      }
    }
    const brief = tools.find((tool) => tool.name === "project_brief");
    for (const field of ["`telemetry.arrivedSince`", "`until`", "`next`", "`api`", "`headline`"]) {
      expect(brief?.description, field).toContain(field);
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

/** What npm serves at each version the plugin names, as the source was when the versions PR released it. */
type Released = {
  "@downtrace/agent": { version: string; commands: string[]; flags: string[] };
  "@downtrace/mcp": { version: string; tools: string[] };
};

describe("what a coding agent runs, which is what npm serves and not the source", () => {
  let released: Released;
  beforeAll(async () => {
    released = (await readJson("released.json")) as Released;
  });

  it("is recorded at the versions the packages were released at", async () => {
    for (const dir of ["agent", "mcp"]) {
      const manifest = (await readJson(`../${dir}/package.json`)) as { name: keyof Released; version: string };
      expect(released[manifest.name]?.version, manifest.name).toBe(manifest.version);
    }
  });

  it("runs the version of @downtrace/agent released with the plugin, in every command of every text", () => {
    const { version } = released["@downtrace/agent"];
    for (const { name, text } of texts) {
      for (const { written, version: named } of versionsOf(text)) {
        expect(named, `${name}: ${written}`).toBe(version);
      }
    }
    expect(versionsOf(block).length).toBeGreaterThan(0);
  });

  it("names only commands and flags that version of downtrace takes", () => {
    const { commands, flags } = released["@downtrace/agent"];
    for (const { name, text } of texts) {
      for (const command of commandsOf(text)) {
        expect(commands, `${name}: ${command.join(" ")}`).toContain(command[0]);
      }
      // Node's own flags, in the line that starts the instrumentation in production, are Node's to read.
      for (const flag of text.replaceAll(/`node [^`]*`/g, "").match(/(?<![\w-])--[a-z]+(?:-[a-z]+)*/g) ?? []) {
        expect(flags, `${name}: ${flag}`).toContain(flag);
      }
    }
  });

  it("names only tools listed by the version of the MCP server the plugin starts", async () => {
    const { version, tools: listed } = released["@downtrace/mcp"];
    const config = (await readJson(".mcp.json")) as { mcpServers: Record<string, { args: string[] }> };
    expect(config.mcpServers.downtrace?.args).toContain(`@downtrace/mcp@${version}`);
    for (const { name, text } of texts) {
      for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        expect(listed, `${name}: ${match[1]}`).toContain(match[1]);
      }
    }
  });
});

describe("the README", () => {
  it("connects the MCP server with downtrace login, and DOWNTRACE_TOKEN is only the override", async () => {
    // covers: RF-514
    const readme = await read("README.md");
    const { version, commands, flags } = ((await readJson("released.json")) as Released)["@downtrace/agent"];
    const login = commandsOf(readme).find((command) => command[0] === "login");
    expect(login, "a downtrace login").toEqual(expect.arrayContaining(["--project"]));
    expect(commandsOf(readme).map((command) => command.join(" "))).toContain("brief --json");
    // What a person or a coding agent copies from here runs what npm serves, as the texts do.
    for (const { written, version: named } of versionsOf(readme)) expect(named, written).toBe(version);
    // Claude Code's own flags, such as `claude --plugin-dir`, are Claude Code's to read.
    for (const command of commandsOf(readme)) {
      expect(commands, command.join(" ")).toContain(command[0]);
      for (const flag of command.filter((word) => word.startsWith("--"))) expect(flags, flag).toContain(flag);
    }
    expect(readme).toMatch(/`DOWNTRACE_TOKEN` is only an override/);
  });

  it("says its limits, and nothing that tells a reader to stay away", async () => {
    // It opened with a banner that called Downtrace a closed pilot, which a coding agent reads as «not for this
    // project» (DT-185). The limits are what a reader needs to decide.
    const readme = await read("README.md");
    expect(readme).not.toMatch(/\bclosed\b(?: \w+)? pilot|by invitation|invite-only/i);
    expect(readme).toMatch(/\bno SLA\b/);
  });
});

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
    // The version released with the plugin, exact: the directory of Claude plugins refuses an npx that is not
    // pinned. `scripts/sync-mcp-version.sh` writes it with the versions PR.
    const mcp = (await readJson("../mcp/package.json")) as { version: string };
    expect(server?.args).toEqual(["-y", `@downtrace/mcp@${mcp.version}`]);
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
