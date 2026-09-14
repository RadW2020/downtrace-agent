import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSubject, subjectOf } from "../src/subject.ts";

/** A repository of its own, so what these assert does not depend on the state of the one we are in. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subject-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(dir, "packages", "agent", "src"), { recursive: true });
  await writeFile(join(dir, "packages", "agent", "package.json"), JSON.stringify({ version: "9.9.9" }));
  await writeFile(join(dir, "packages", "agent", "src", "register.ts"), "");
  git("add", "-A");
  git("commit", "-qm", "first");
  return dir;
}

describe("what a measurement measured", () => {
  it("names the version, the commit and a clean tree, and records the path relative to the repository", async () => {
    const dir = await repo();
    const s = subjectOf(join(dir, "packages", "agent", "src", "register.ts"), dir);
    expect(s.version).toBe("9.9.9");
    expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(s.dirty).toBe(false);
    expect(s.source).toBe("working-tree");
    // An absolute path carries somebody's home directory, which is not part of the identity.
    expect(s.agentPath).toBe(join("packages", "agent", "src", "register.ts"));
  });

  it("says the tree was dirty, because a commit does not describe uncommitted changes", async () => {
    const dir = await repo();
    await writeFile(join(dir, "packages", "agent", "src", "register.ts"), "// changed");
    expect(subjectOf(join(dir, "packages", "agent", "src", "register.ts"), dir).dirty).toBe(true);
  });

  it("tells an installed package from the repository's own sources", async () => {
    const dir = await repo();
    const installed = join(dir, "node_modules", "@downtrace", "agent", "dist", "register.js");
    await mkdir(join(dir, "node_modules", "@downtrace", "agent", "dist"), { recursive: true });
    await writeFile(
      join(dir, "node_modules", "@downtrace", "agent", "package.json"),
      JSON.stringify({ version: "0.8.1" }),
    );
    await writeFile(installed, "");
    const s = subjectOf(installed, dir);
    expect(s.source).toBe("installed");
    expect(s.version).toBe("0.8.1");
  });

  it("says it could not tell instead of guessing, when there is no git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nogit-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "register.ts"), "");
    const s = subjectOf(join(dir, "src", "register.ts"), dir);
    expect(s.commit).toBeNull();
    // Null and not false: «we could not tell» is not «clean».
    expect(s.dirty).toBeNull();
  });

  it("puts the provenance on one line, so a pasted result carries it", async () => {
    const dir = await repo();
    const line = describeSubject(subjectOf(join(dir, "packages", "agent", "src", "register.ts"), dir));
    expect(line).toContain("9.9.9");
    expect(line).toContain("clean tree");
    expect(line).toContain("working tree");
  });

  it("names the commit the tree was copied from, because its own resolves nowhere upstream", async () => {
    const dir = await repo();
    const upstream = "71cde46b9f2a4c1d8e3f05a6b7c8d9e0f1a2b3c4";
    const s = subjectOf(join(dir, "packages", "agent", "src", "register.ts"), dir, upstream);
    expect(s.sourceCommit).toBe(upstream);
    // The tree's own commit is still its own: the copy does not overwrite the identity of what ran.
    expect(s.commit).not.toBe(upstream);
    expect(describeSubject(s)).toContain("copied from 71cde46b9f2a");
  });

  it("leaves the field out where there is no upstream, because absent reads as «does not apply»", async () => {
    const dir = await repo();
    const s = subjectOf(join(dir, "packages", "agent", "src", "register.ts"), dir);
    // Not null: null is this interface's word for «we could not tell», and a local run is not that.
    expect("sourceCommit" in s).toBe(false);
    expect(JSON.parse(JSON.stringify(s))).not.toHaveProperty("sourceCommit");
    expect(describeSubject(s)).not.toContain("copied from");
  });
});
