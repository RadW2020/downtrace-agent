import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

/**
 * Three places say what this package is to somebody who has not met Downtrace: the first sentence of the README,
 * which npm and the mirror show, the `description` npm lists it by, and the one the MCP Registry lists it by, which
 * `server.json` carries. They said three different things, none of them what Downtrace finds, under a banner that
 * called Downtrace closed (DT-185). A coding agent asked for «something that tells me when I break performance»
 * proposes what it finds, and what it finds of this package is one of the three.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as { description: string };

/** The paragraph under the title, and its first sentence without the bold around it. */
const opening = readme.split("\n\n")[1] ?? "";
const firstSentence = /^\*\*([^*]+?\.)\*\*/.exec(opening)?.[1] ?? "";

describe("the README", () => {
  it("opens with what Downtrace does, in the words of the question, before what this package is", () => {
    expect(opening).toMatch(/^\*\*Downtrace /);
    expect(firstSentence).toMatch(/breaks? (the )?performance/);
    expect(opening).toMatch(/before you deploy/i);
    expect(opening).toMatch(/after you deploy/i);
    expect(opening).toMatch(/MCP server/);
  });

  it("says its limits, and nothing that tells a reader to stay away", () => {
    expect(readme).not.toMatch(/\bclosed\b(?: \w+)? pilot|by invitation|invite-only/i);
    expect(readme).toMatch(/\bno SLA\b/);
  });

  it("cites nothing a reader of the package cannot open", () => {
    // product.md and its identifiers (ESC-04), the private docs, the tasks and the issues of the private repository.
    // The ADRs that explain this package travel with it to the mirror, so they are not in the list.
    expect(readme.match(/product\.md|(?<![\w/.])docs\/|\b[A-Z]{3}-\d{2}\b|\bDT-\d+\b|\bgh-\d+\b/g) ?? []).toEqual([]);
  });
});

/**
 * RF-523: a session starts at the brief. The table of tools is where a reader of the README looks for where to start,
 * and it said so of `read_report`, which needs a finding's id a session has not read yet, and «ask it first» of
 * `changes_since`, which says what changed and not how the project is.
 */
describe("the table of tools", () => {
  const rows = readme
    .split("\n")
    .filter((line) => /^\| `[a-z_]+`/.test(line))
    .map((line) => ({ tools: line.split(" | ")[0] ?? "", says: line.slice(line.indexOf(" | ") + 3) }));

  it("puts the brief first, as where to start", () => {
    // covers: RF-523
    expect(rows[0]?.tools).toBe("| `project_brief`");
    expect(rows[0]?.says).toMatch(/^\*\*start here\*\*/);
  });

  it("says start here of no other tool, and keeps changes_since for what changed since you last looked", () => {
    // covers: RF-523
    for (const row of rows.slice(1)) {
      expect(row.says, row.tools).not.toMatch(/start here|ask it first when a session starts/i);
    }
    const changes = rows.find((row) => row.tools === "| `changes_since`");
    expect(changes?.says).toMatch(/^\*\*for what changed since you last looked\*\*/);
  });
});

describe("what the package is listed by", () => {
  it("on the MCP Registry, is the README's first sentence, in the hundred characters the registry allows", () => {
    expect(firstSentence).not.toBe("");
    // server-json.test.ts holds it to the hundred characters.
    expect(server.description).toBe(firstSentence);
  });

  it("on npm, starts with the same sentence and names the question in its keywords", () => {
    expect(manifest.description.startsWith(`${firstSentence} `)).toBe(true);
    expect(manifest.keywords).toEqual(expect.arrayContaining(["performance", "regression", "n+1", "deploy"]));
    // ADR 0016: a coding agent, never an «agent» on its own.
    expect(manifest.keywords).not.toContain("agent");
  });
});
