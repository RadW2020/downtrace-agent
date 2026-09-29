import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The subject a run records says whether the tree was dirty, read with `git status --porcelain` (src/subject.ts),
 * and that count includes untracked files: a report a campaign wrote with its default `--out` in a clean checkout
 * leaves a loose file, and every campaign that follows on that checkout then declares a subject that was never
 * measured. A report that declares a false subject is worse than no measurement (ADR 0134), so the default every
 * campaign's `--out` falls back to must already be ignored where it lands. The campaigns and their defaults are
 * read from the source and from git, never copied (gh-845): the same hole opened three times — coexistence in
 * gh-615, instruments and profile in gh-592 — is what this exists to keep shut.
 */

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const clis = readdirSync(srcDir)
  .filter((f) => f.endsWith("-cli.ts"))
  .sort();

/** The default `--out` a CLI falls back to, or nothing when the campaign writes no report (load-cli). */
function outDefault(source: string): string | undefined {
  const match = source.match(/out:\s*\{\s*type:\s*"string",\s*default:\s*"([^"]+)"/);
  return match?.[1];
}

/** What git itself says about a file the campaign writes beside the package. */
function isIgnored(file: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", join("packages/bench", file)], { cwd: root, stdio: "pipe" });
    return true;
  } catch (e) {
    // Exit 1 is "not ignored" (the finding); anything else is a broken git and must not read as a pass.
    if ((e as { status?: number }).status !== 1) throw e;
    return false;
  }
}

describe("the default report of every campaign is ignored where it lands", () => {
  it("enumerates the campaigns, so a new one is checked without a copied list", () => {
    expect(clis.length).toBeGreaterThan(0);
  });

  for (const cli of clis) {
    it(`${cli} leaves no default report in the tree`, () => {
      const file = outDefault(readFileSync(join(srcDir, cli), "utf8"));
      if (file === undefined) return;
      expect(isIgnored(file), `${cli} writes packages/bench/${file} by default, and .gitignore does not cover it`).toBe(
        true,
      );
    });
  }

  it("the raw .cpuprofile the profile campaign keeps beside its report is ignored too", () => {
    expect(
      isIgnored("profile-report.agent.cpuprofile"),
      "packages/bench/profile-report.agent.cpuprofile is not covered by .gitignore",
    ).toBe(true);
  });
});
