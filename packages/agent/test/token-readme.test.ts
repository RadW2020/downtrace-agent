import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { INGESTION_TOKEN } from "../src/init/report.ts";
import { readDocumentation } from "./support/documentation.ts";

/**
 * The ingestion token is public by design, like a Sentry DSN, and the README says so in a section of its own: that it
 * is safe to commit, what whoever holds it can and cannot do, and how it is replaced. In the words `downtrace init`
 * prints, read from the source, so that a person who reads the README and a coding agent that runs init are told the
 * same thing.
 */

const HEADING = "## The ingestion token is safe to commit";

/** Without the backticks, the bold and the wrapping of the lines, which are how the README is written and not what it says. */
const flat = (text: string): string => text.replaceAll("`", "").replaceAll("**", "").replaceAll(/\s+/g, " ");

let section: string;
let docs: string;
beforeAll(async () => {
  const page = await readFile(new URL("../guide/production.md", import.meta.url), "utf8");
  const start = page.indexOf(HEADING);
  section = start < 0 ? "" : flat(page.slice(start, page.indexOf("\n## ", start + 1)));
  docs = flat(await readDocumentation());
});

describe("the production page on the ingestion token", () => {
  it("has a section of its own, which says the token is safe to commit and gives it where the token is given", () => {
    expect(section).not.toBe("");
    expect(section).toContain("safe to commit");
    expect(section).toContain("like a Sentry DSN");
    expect(section).toContain("DOWNTRACE_TOKEN");
  });

  // The DSN carries the cloud's URL and the token, and is written in code by design: it is public for the same reason.
  it("says the DSN, which carries the token, is public for the same reason", () => {
    expect(section).toContain("DOWNTRACE_DSN");
    expect(section).toContain("init({ dsn })");
  });

  it.each(INGESTION_TOKEN.can)("says that whoever holds it can %s", (can) => {
    expect(section).toContain(can);
  });

  it("says what whoever holds it cannot do, and how it is replaced", () => {
    expect(section).toContain(INGESTION_TOKEN.cannot);
    expect(section).toContain(INGESTION_TOKEN.replace);
  });

  // An unbound token writes as whatever environment the batch declares: committing one is committing a token that
  // writes production.
  it("says an unbound token is to be replaced before it is committed", () => {
    expect(section).toContain("unbound");
  });

  // An access credential travels in a variable of the same name, to the MCP server, and it reads and operates: the
  // section that says one token is public says the other is not.
  it("says an access credential is a secret, and not the token it describes", () => {
    expect(section).toContain("dtr_… ");
    expect(section).toContain("is a secret: never commit it");
  });

  it("names, in the guide of init, the field of the JSON that says it and each of its keys", () => {
    expect(docs).toContain("token (");
    for (const key of Object.keys(INGESTION_TOKEN)) expect(docs, key).toContain(key);
  });
});
