import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_FILE } from "../check/config.ts";
import {
  AGENT_PACKAGE,
  type Detection,
  detect,
  FRAMEWORK_PACKAGES,
  type PackageManager,
  parsePackageJson,
  REGISTER_SPECIFIER,
  readIfThere,
  TEST_SCRIPTS,
} from "./detect.ts";
import { INSTRUMENTATION_FILE, planConfig } from "./files.ts";
import {
  exitCodeOfInit,
  type FileAction,
  INIT_SCHEMA,
  type InitFailure,
  type InitReport,
  type Missing,
  renderInitJson,
  renderInitText,
} from "./report.ts";

/**
 * `downtrace init`: configures a project with no question a coding agent cannot answer (ADO-01). It reads the
 * project, writes the test command where `check` reads it and the instrumentation hook a pruning build needs, and
 * says what it could not detect and what to do instead. It asks for no token and makes no network request: locally
 * there is no cloud.
 *
 * Run twice, it writes nothing twice: a command already in `downtrace.json` is the person's and stays, every key it
 * does not write stays, and the hook is written only where the project has none.
 */

export interface InitDeps {
  cwd: string;
  json: boolean;
  stdout: (text: string) => void;
}

/** Runs init in `cwd`, says the result and returns the exit status: 0 configured, 1 something to do, 2 failed. */
export async function runInit(deps: InitDeps): Promise<number> {
  const report = await initProject(resolve(deps.cwd));
  deps.stdout(deps.json ? renderInitJson(report) : renderInitText(report));
  return exitCodeOfInit(report);
}

const INSTALL: Record<PackageManager, string> = {
  npm: `npm install ${AGENT_PACKAGE}`,
  pnpm: `pnpm add ${AGENT_PACKAGE}`,
  yarn: `yarn add ${AGENT_PACKAGE}`,
  bun: `bun add ${AGENT_PACKAGE}`,
};

function report(project: string, rest: Partial<InitReport>): InitReport {
  return {
    schema: INIT_SCHEMA,
    status: "configured",
    project,
    detected: null,
    command: null,
    files: [],
    missing: [],
    failure: null,
    next: null,
    ...rest,
  };
}

const failed = (project: string, failure: InitFailure): InitReport => report(project, { status: "failed", failure });

/** Looks at the project in `dir` and writes what it needs. Never throws: what goes wrong is in the report. */
export async function initProject(dir: string): Promise<InitReport> {
  try {
    return await configure(dir);
  } catch (err) {
    return failed(dir, {
      code: "io-error",
      message: `a file could not be read or written: ${err instanceof Error ? err.message : String(err)}`,
      advice:
        "Fix what the message names and run init again: what it already wrote is kept, and nothing is written twice.",
    });
  }
}

/**
 * How a command of this package is spelled for a project: `npx downtrace` finds the bin of a project that has the
 * package, and where it does not, it would look the name up on the registry, and that name is not ours.
 */
function npx(found: Detection): string {
  return found.installed ? "npx downtrace" : `npx ${AGENT_PACKAGE}`;
}

/** What is left to do about what `detect` found, apart from the Next.js hook. */
function missingOf(found: Detection, command: string | undefined, dir: string): Missing[] {
  const invoke = npx(found);
  const missing: Missing[] = [];
  if (found.frameworks.length === 0) {
    missing.push({
      code: "no-framework",
      message: `package.json depends on none of the frameworks whose routes Downtrace names by their templates (${FRAMEWORK_PACKAGES.join(", ")})`,
      advice:
        "In a monorepo, run init in the directory of the service. Elsewhere check still compares the runs: the " +
        "instrumentation observes every request through node:http and names its route by the shape of its path, " +
        "and downtrace.json needs only the test command.",
    });
  }
  if (command === undefined) {
    missing.push({
      code: "no-test-command",
      message: `package.json has no test script init can run: it looks for ${TEST_SCRIPTS.join(", ")}, and npm's placeholder is not one`,
      advice:
        "Give check a command that sends requests to the routes with their real dependencies: a test script, or a " +
        "walk of the routes — a script that starts the application, sends a request to each route and stops it. " +
        `Write it in downtrace.json as {"check": {"command": "<command>"}}, or pass it after --: ${invoke} check -- <command>.`,
    });
  }
  if (!found.repository) {
    missing.push({
      code: "not-a-repository",
      message: `no git repository holds ${dir}`,
      advice:
        "check compares the working tree against a commit, so it runs inside a git repository: run it where the project is under git.",
    });
  }
  return missing;
}

async function configure(dir: string): Promise<InitReport> {
  const pkgPath = join(dir, "package.json");
  const pkgText = await readIfThere(pkgPath);
  if (pkgText === undefined) {
    return report(dir, {
      status: "incomplete",
      missing: [
        {
          code: "no-package-json",
          message: `there is no package.json in ${dir}`,
          advice:
            "Run init at the root of the Node.js project, where its package.json is; in a monorepo, in the directory of the service.",
        },
      ],
    });
  }
  const parsed = parsePackageJson(pkgText, pkgPath);
  if (!parsed.ok) {
    return failed(dir, {
      code: "bad-package-json",
      message: parsed.reason,
      advice: "Fix it and run init again: init reads package.json and never rewrites it.",
    });
  }

  const found = await detect(dir, parsed.pkg);
  const configPath = join(dir, CONFIG_FILE);
  const plan = planConfig(await readIfThere(configPath), found.testCommand, configPath);
  if (plan.kind === "refuse") {
    return failed(dir, {
      code: "bad-config",
      message: plan.reason,
      advice: `Fix it or remove it, and run init again: init does not rewrite a ${CONFIG_FILE} that check would refuse.`,
    });
  }

  const files: Array<{ path: string; action: FileAction }> = [];
  const writes: Array<{ path: string; text: string; create: boolean }> = [];
  if (plan.kind === "create" || plan.kind === "update") {
    writes.push({ path: CONFIG_FILE, text: plan.text, create: plan.kind === "create" });
  } else if (plan.kind === "keep") {
    files.push({ path: CONFIG_FILE, action: "unchanged" });
  }
  const command = plan.kind === "none" ? undefined : plan.command;
  const missing = missingOf(found, command, dir);

  const next = found.next;
  if (next?.existing !== undefined) {
    if (next.existing.loads) files.push({ path: next.existing.path, action: "unchanged" });
    else {
      missing.push({
        code: "instrumentation-exists",
        message: `${next.existing.path} exists and does not load the instrumentation`,
        advice:
          `Add this inside its register() function, which Next runs before it serves anything: ` +
          `if (process.env.NEXT_RUNTIME === "nodejs") await import("${REGISTER_SPECIFIER}"); — the import is what ` +
          `makes output: "standalone" ship the package, and the condition keeps it out of the edge runtime, which cannot load it.`,
      });
    }
  } else if (next !== undefined) {
    if (!found.installed) {
      missing.push({
        code: "not-installed",
        message: `the build prunes what nothing imports (output: "standalone" in ${next.config}) and ${AGENT_PACKAGE} is not a dependency of the project, so a hook that imports it would break the build`,
        advice: `Install it — ${INSTALL[found.manager]} — and run npx downtrace init again: it writes ${next.target}.`,
      });
    }
    if (next.unresolving !== undefined) {
      missing.push({
        code: "module-resolution",
        message: `tsconfig.json sets "moduleResolution" to "${next.unresolving}", which cannot resolve ${REGISTER_SPECIFIER}`,
        advice: `Set it to "bundler" (what Next puts in new projects), "node16" or "nodenext", and run init again: it writes ${next.target}.`,
      });
    }
    if (found.installed && next.unresolving === undefined) {
      writes.push({ path: next.target, text: INSTRUMENTATION_FILE, create: true });
    }
  }

  for (const write of writes) {
    // A file created here is one that was not there when init looked: `wx` refuses to replace one that appeared since.
    await writeFile(join(dir, write.path), write.text, { flag: write.create ? "wx" : "w" });
    files.push({ path: write.path, action: write.create ? "created" : "updated" });
  }

  return report(dir, {
    status: missing.length === 0 ? "configured" : "incomplete",
    detected: {
      packageManager: found.manager,
      frameworks: found.frameworks,
      observed: found.observed,
      testScript: found.testScript ?? null,
      testCommand: found.testCommand ?? null,
      bundler: next === undefined ? null : "next-standalone",
    },
    command: command ?? null,
    files,
    missing,
    next: command === undefined ? null : `${npx(found)} check`,
  });
}
