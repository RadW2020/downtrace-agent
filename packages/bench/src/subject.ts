import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * What a measurement measured.
 *
 * The report used to carry the Node version and the platform and nothing about the instrumentation, so a
 * green from another version read exactly like a green from this one. The evidence for invariant 3 is the runs
 * themselves — after a merge on a machine of its own, and by hand (ADR 0032, 0134) — and a run with no
 * provenance is a number with no owner (gh-525). It matters more, not less, now that the runs form a series:
 * two points cannot be compared without knowing what each of them measured.
 *
 * Every field can be `null`, and `null` here means «we could not tell», which is not the same as «does not
 * apply». An absent field would read as the second.
 */
export interface BenchSubject {
  /** The module the agent variant loaded, relative to the repository when it is inside it. */
  agentPath: string;
  /** Version of the package that governs that module, or null when it could not be read. */
  version: string | null;
  /** The commit the tree was at, or null when there is no git to ask. */
  commit: string | null;
  /** Whether that tree had uncommitted changes. Null when the commit is null: unknown, not clean. */
  dirty: boolean | null;
  /**
   * Where the measured code came from. `working-tree` is the repository's own sources and `installed` is
   * what a package manager put in `node_modules`: they are not interchangeable evidence.
   */
  source: "working-tree" | "installed" | "unknown";
  /**
   * The commit, in the repository this tree was copied from, that the copy was made at. Optional and never
   * `null`, which is the distinction the rest of this interface draws: a run in the repository where the code
   * is written has no upstream commit, and that is «does not apply», not «we could not tell». It exists
   * because `commit` above is the commit of the tree that ran, and when that tree is a copy — the public
   * mirror, where the benchmark now measures — that sha resolves nowhere for whoever reads the report.
   */
  sourceCommit?: string;
}

/**
 * Resolves the subject, and never throws: a benchmark that cannot say what it measured still has to run and
 * say so. Everything it cannot determine comes back as an explicit unknown.
 */
export function subjectOf(agentPath: string, repoRoot: string, sourceCommit?: string): BenchSubject {
  const absolute = resolve(agentPath);
  const inside = isInside(absolute, repoRoot);
  const node_modules = absolute.split(sep).includes("node_modules");
  return {
    // Spread rather than assigned, so that not having been told leaves no field at all.
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    // Relative inside the repository: an absolute path carries somebody's home directory, which is nobody
    // else's business and is not part of the identity.
    agentPath: inside ? relative(repoRoot, absolute) : absolute,
    version: versionNear(absolute),
    commit: gitOutput(repoRoot, ["rev-parse", "HEAD"]),
    dirty: dirtyIn(repoRoot),
    source: node_modules ? "installed" : inside ? "working-tree" : "unknown",
  };
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The version of the nearest `package.json` above the module, which is the package that governs it. */
function versionNear(from: string): string | null {
  let dir = dirname(from);
  for (let up = 0; up < 8; up++) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        // The manifest is a file this repository wrote, but it is still parsed input: a version that is not
        // a string is not a version.
        const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
        const version = (parsed as { version?: unknown }).version;
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // No git, no repository, or a git that refused: all of them are «we could not tell».
    return null;
  }
}

function dirtyIn(cwd: string): boolean | null {
  const status = gitOutput(cwd, ["status", "--porcelain"]);
  if (status === null) return gitOutput(cwd, ["rev-parse", "HEAD"]) === null ? null : false;
  return status.length > 0;
}

/** One line, so a pasted result carries its provenance with it. */
export function describeSubject(s: BenchSubject): string {
  const version = s.version ?? "version unknown";
  const commit = s.commit ? s.commit.slice(0, 12) : "commit unknown";
  const tree = s.dirty === null ? "tree unknown" : s.dirty ? "**uncommitted changes**" : "clean tree";
  const copied = s.sourceCommit ? ` · copied from ${s.sourceCommit.slice(0, 12)}` : "";
  return `Measured \`${s.agentPath}\` · ${version} · ${commit} · ${tree} · from the ${s.source.replace("-", " ")}${copied}`;
}
