import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describe, expect, it } from "vitest";
import { cliArgs } from "../src/cli-args.ts";

/**
 * pnpm forwards the literal `--` of `pnpm run <campaign> -- <flags>` to the script, and to `parseArgs` a
 * leading `--` is the separator that demotes every flag after it to a positional (gh-853): with the campaigns'
 * old `allowPositionals: true` the flags were dropped and the campaign ran on its defaults without a word, its
 * report proudly stating the defaults it ran on. `cliArgs` strips the one forwarded `--`, and the campaigns
 * parse `allowPositionals: false`, so whatever survives the strip is a usage error and never a silent default.
 */

const OPTIONS = { rounds: { type: "string", default: "9" } } as const;

/** What a campaign parses out of the raw argv pnpm (or node) gave it. */
function parse(raw: readonly string[]): Record<string, string> {
  return parseArgs({
    args: cliArgs(raw),
    allowPositionals: false,
    options: OPTIONS,
  }).values as Record<string, string>;
}

/** The code of the error `fn` threw, or nothing when it parsed. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe("the forwarded `--`", () => {
  it("what pnpm forwards ran the old pattern on its defaults: the bug, as the campaigns lived with it", () => {
    const { values, positionals } = parseArgs({
      args: ["--", "--rounds", "1"],
      allowPositionals: true,
      options: OPTIONS,
    });
    // `--rounds 1` became positionals the campaign never read; rounds kept its default.
    expect(values.rounds).toBe("9");
    expect(positionals).toEqual(["--rounds", "1"]);
  });

  it("cliArgs strips the one leading `--`, and nothing else", () => {
    expect(cliArgs(["--", "--rounds", "1"])).toEqual(["--rounds", "1"]);
    expect(cliArgs(["--rounds", "1"])).toEqual(["--rounds", "1"]);
    expect(cliArgs([])).toEqual([]);
  });

  it("a second `--` is the campaign's own separator and is left in place", () => {
    expect(cliArgs(["--", "--", "--rounds", "1"])).toEqual(["--", "--rounds", "1"]);
  });

  it("the flags parse, with the forwarded `--` and without it", () => {
    expect(parse(["--", "--rounds", "1"]).rounds).toBe("1");
    expect(parse(["--rounds", "1"]).rounds).toBe("1");
  });

  it("what survives the strip is refused, not swallowed: the campaign never takes the defaults", () => {
    expect(codeOf(() => parse(["--", "--", "--rounds", "1"]))).toBe("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
    expect(codeOf(() => parse(["rounds=1"]))).toBe("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
  });
});

describe("a campaign that is handed garbage exits non-zero before it measures", () => {
  function spawn(cli: string, args: string[]) {
    const script = fileURLToPath(new URL(`../src/${cli}`, import.meta.url));
    try {
      execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });
      return { code: 0, err: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { code: err.status ?? -1, err: err.stderr ?? "" };
    }
  }

  it("a second `--` is a usage error (load-cli)", () => {
    const r = spawn("load-cli.ts", ["--", "--", "--rps", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
  });

  it("a bare positional is a usage error (load-cli)", () => {
    const r = spawn("load-cli.ts", ["rounds=1"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
  });
});

describe("every campaign in src/ parses through cliArgs", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const clis = readdirSync(srcDir)
    .filter((f) => f.endsWith("-cli.ts"))
    .sort();

  it("enumerates the campaigns, so a new one is checked without a copied list", () => {
    expect(clis.length).toBeGreaterThan(0);
  });

  for (const cli of clis) {
    it(`${cli} strips the forwarded \`--\` through cliArgs and does not allow positionals`, () => {
      const source = readFileSync(join(srcDir, cli), "utf8");
      expect(source).toContain('from "./cli-args.ts"');
      expect(source).toContain("cliArgs(process.argv.slice(2))");
      expect(source).not.toContain("allowPositionals: true");
    });
  }
});
