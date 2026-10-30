import { OBSERVED_PACKAGES, UNOBSERVED_PACKAGES, unobservedOf } from "../init/detect.ts";
import type { NotEvaluatedReason } from "./compare.ts";
import { scriptOf, unseenObservers } from "./hints.ts";
import type { CheckReport } from "./report.ts";

/**
 * What `check` offers when it could not see something it is there to see: a run that left no profile, a run in which
 * nothing could be evaluated, routes in which nothing was observed in a project that depends on a driver the
 * instrumentation does not observe, a driver it observes that it could not find. A route with nothing observed in a
 * project whose drivers are all observed is a route with no dependencies, a health check, and offers nothing: a
 * link on every run would be read by nobody. Those are the runs that say what Downtrace misses in projects nobody
 * here has seen — a driver it does not observe, a runner that does not let it write — and the person who ran it is
 * the only one who knows.
 *
 * So the report carries a link to a new issue on the public repository, filled in with what the report says and
 * nothing of the code: versions, the frameworks and data packages the project depends on among names Downtrace
 * knows, the test runner among names it knows, the codes of what went wrong and how many routes each covers. Never
 * a route, a path, the test command or its output. **Nothing is sent**: `check` makes no request (LOC-01), the link
 * only opens a form the person reads, changes and submits, or not. A run with nothing of the kind carries no link.
 */
export interface Feedback {
  /** What Downtrace could not see, in one sentence. */
  why: string;
  /** A new issue on the public repository, filled in; opened by a person, never sent by `check`. */
  url: string;
}

/** The public repository's issues, which are where outside reports come in. */
export const ISSUES_URL = "https://github.com/RadW2020/downtrace-agent/issues/new";

/**
 * The packages of a project's data that a report names when the project depends on them: those the instrumentation
 * observes, those it does not, and those it sees only through another — an ORM through its driver, a client over
 * HTTP as calls. Known names only, so that nothing of a project that is not a public package's name is written.
 */
export const DATA_PACKAGES = [
  ...OBSERVED_PACKAGES,
  ...UNOBSERVED_PACKAGES,
  "@prisma/client",
  "drizzle-orm",
  "knex",
  "kysely",
  "sequelize",
  "typeorm",
  "@mikro-orm/core",
  "@neondatabase/serverless",
  "@vercel/postgres",
  "@planetscale/database",
  "@supabase/supabase-js",
  "@upstash/redis",
  "bullmq",
  "@aws-sdk/client-dynamodb",
  "firebase-admin",
  "@elastic/elasticsearch",
] as const;

/** The frameworks a report names. */
export const FRAMEWORKS = ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hono", "next", "@strapi/strapi"];

/** The test runners a report names, as the command or the script it runs calls them. */
export const RUNNERS = ["vitest", "jest", "mocha", "ava", "tap", "node --test", "bun test", "playwright", "jasmine"];

/** What `check` knows of the project and of the process, besides its report. */
export interface FeedbackContext {
  version: string;
  node: string;
  platform: string;
  /** Every package the project's `package.json` depends on; only known names are written. */
  dependencies: ReadonlySet<string>;
  /** The range each is declared with, for a package observed only from a version on. Never written. */
  ranges?: ReadonlyMap<string, string>;
  /** The test command, and the script it runs when it runs one: read for a runner's name, never written. */
  command: string;
  scripts: Readonly<Record<string, string>>;
}

/** The runner's name, read from the command, or from the package script the command runs. */
function runnerOf(context: FeedbackContext): string | undefined {
  const script = scriptOf(context.command);
  const texts = [context.command, script === undefined ? undefined : context.scripts[script]];
  for (const text of texts) {
    if (text === undefined) continue;
    const found = RUNNERS.find((runner) => new RegExp(`(^|[\\s/])${runner}(\\s|$)`).test(text));
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What Downtrace could not see in this report, or nothing when it saw what it is there to see. */
function whyOf(report: CheckReport, context: FeedbackContext): { why: string; title: string } | undefined {
  const failure = report.failure;
  if (failure !== null && (failure.code === "no-profile" || failure.code === "nothing-evaluated")) {
    return { why: `check could not compare (${failure.code}): ${failure.message}`, title: `check: ${failure.code}` };
  }
  const blind = report.routes.filter((route) => route.reasons.some((reason) => reason.code === "nothing-observed"));
  const unobserved = unobservedOf(context.dependencies, context.ranges);
  if (blind.length > 0 && unobserved.length > 0) {
    const routes = `${blind.length} ${blind.length === 1 ? "route was" : "routes were"}`;
    return {
      why:
        `${routes} called and nothing was observed inside ${blind.length === 1 ? "its" : "their"} requests, and ` +
        `the project depends on ${unobserved.join(", ")}, which Downtrace does not observe`,
      title: `check: ${unobserved.join(", ")} not observed`,
    };
  }
  for (const side of [report.base, report.change]) {
    const [unseen] = unseenObservers(side?.observers ?? {}, context.dependencies);
    if (unseen !== undefined) {
      const said = unseen.state === "unavailable" ? "was unavailable" : "found no driver";
      return {
        why: `the ${unseen.observer} observer ${said}, and the project depends on ${unseen.packages.join(", ")}`,
        title: `check: ${unseen.observer} unavailable`,
      };
    }
  }
  return undefined;
}

/** How many routes each reason they were not evaluated for covers, as `code: n`. */
function reasonCounts(report: CheckReport): string {
  const counts = new Map<NotEvaluatedReason, number>();
  for (const route of report.routes) {
    for (const reason of route.reasons) counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
  }
  return [...counts].map(([code, n]) => `${code}: ${n}`).join(", ");
}

const observersOf = (observers: Record<string, string> | undefined): string =>
  Object.entries(observers ?? {})
    .map(([name, state]) => `${name} ${state}`)
    .join(", ");

/** The link `check` offers with this report, or null when there is nothing Downtrace could not see. */
export function feedbackFor(report: CheckReport, context: FeedbackContext): Feedback | null {
  const found = whyOf(report, context);
  if (found === undefined) return null;
  const known = (names: readonly string[]): string =>
    names.filter((name) => context.dependencies.has(name)).join(", ") || "none Downtrace knows";
  const rows: Array<[string, string]> = [
    ["`@downtrace/agent`", context.version],
    ["Node", `${context.node} on ${context.platform}`],
    ["Frameworks", known(FRAMEWORKS)],
    ["Data packages", known(DATA_PACKAGES)],
    ["Test runner", runnerOf(context) ?? "none Downtrace knows"],
    ["Failure", report.failure === null ? "none" : `${report.failure.code} (${report.failure.side ?? "both runs"})`],
    ["Routes not evaluated", reasonCounts(report) || "none"],
    ["Observers, base", observersOf(report.base?.observers) || "no run"],
    ["Observers, change", observersOf(report.change?.observers) || "no run"],
  ];
  const body = [
    "<!-- Written by `downtrace check`, and nothing was sent: read it, change what you want, and submit it only if you want us to see it. -->",
    "",
    `**What check said:** ${found.why}.`,
    "",
    "**What the project uses that Downtrace may have missed** (a driver, a client, how the tests start the application):",
    "",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
  ].join("\n");
  const url = `${ISSUES_URL}?${new URLSearchParams({ title: found.title, body }).toString()}`;
  return { why: found.why, url };
}
