import { describe, expect, it } from "vitest";
import type { RouteResult } from "../src/check/compare.ts";
import { type FeedbackContext, feedbackFor, ISSUES_URL } from "../src/check/feedback.ts";
import { renderText } from "../src/check/render.ts";
import { type CheckReport, compared, failed, type SideReport } from "../src/check/report.ts";

/**
 * The link `check` offers when Downtrace could not see something: when it is offered, when it is not, and what the
 * issue it opens says — which is what the report says, and nothing of the code. Nothing is sent by any of it.
 */
// covers: LOC-01

const side = (ref: string, over: Partial<SideReport> = {}): SideReport => ({
  ref,
  commit: "9fb6e99ca1f0",
  command: "npm test",
  exitCode: 0,
  durationMs: 1400,
  processes: 1,
  batches: 2,
  requests: 6,
  routes: 2,
  profileWindows: 1,
  malformed: 0,
  observers: { pg: "on", http: "on", redis: "on", runtime: "on" },
  ...over,
});

/** A route as `compare.ts` makes it, with only what the feedback reads filled in. */
const route = (id: string, codes: RouteResult["reasons"][number]["code"][] = []): RouteResult =>
  ({
    id,
    verdict: codes.length === 0 ? "unchanged" : "not-evaluated",
    reasons: codes.map((code) => ({ code, message: code })),
  }) as unknown as RouteResult;

const context = (over: Partial<FeedbackContext> = {}): FeedbackContext => ({
  version: "0.12.0",
  node: "v22.11.0",
  platform: "linux",
  dependencies: new Set(["express", "pg", "acme-internal-billing"]),
  command: "DATABASE_URL=postgres://dt-user:hunter2-zq@db.internal/payroll npm test",
  scripts: { test: "vitest run --config vitest.secret-zq.ts" },
  ...over,
});

const reportWith = (routes: RouteResult[], over: { base?: Partial<SideReport> } = {}): CheckReport =>
  compared({ base: side("HEAD", over.base), change: side("working tree"), routes, notes: [] });

/** The issue the link opens, as GitHub reads its query. */
function issueOf(url: string): { title: string; body: string } {
  const parsed = new URL(url);
  return { title: parsed.searchParams.get("title") ?? "", body: parsed.searchParams.get("body") ?? "" };
}

describe("when check offers a link", () => {
  it("offers nothing for a run that saw what it is there to see, a health check with no dependencies included", () => {
    const report = reportWith([route("GET /products"), route("GET /health", ["nothing-observed"])]);
    expect(feedbackFor(report, context())).toBeNull();
  });

  it("offers nothing when the project's own tests failed: that is the project's to fix", () => {
    const report = failed({
      failure: { code: "command-failed", side: "change", message: "the tests failed", advice: null, outputTail: "x" },
    });
    expect(feedbackFor(report, context())).toBeNull();
  });

  it("offers it when a run left no profile, or nothing could be evaluated", () => {
    for (const code of ["no-profile", "nothing-evaluated"] as const) {
      const report = failed({
        failure: { code, side: "base", message: "what it said", advice: null, outputTail: null },
      });
      const feedback = feedbackFor(report, context());
      expect(feedback?.why, code).toContain(code);
      expect(issueOf(feedback?.url ?? "").title).toBe(`check: ${code}`);
    }
  });

  it("offers it when routes saw nothing in a project that depends on a driver Downtrace does not observe", () => {
    const report = reportWith([route("GET /products"), route("GET /tenants/:tenant/invoices", ["nothing-observed"])]);
    const feedback = feedbackFor(report, context({ dependencies: new Set(["express", "sqlite3"]) }));
    expect(feedback?.why).toBe(
      "1 route was called and nothing was observed inside its requests, and the project depends on sqlite3, " +
        "which Downtrace does not observe",
    );
    expect(issueOf(feedback?.url ?? "").title).toBe("check: sqlite3 not observed");
  });

  it.each([
    ["mysql", "mysql2"],
    ["sqlite", "better-sqlite3"],
    ["sqlite", "@libsql/client"],
    ["mongodb", "mongoose"],
  ])("offers it when the %s observer was unavailable in a project that depends on %s", (observer, dependency) => {
    const unavailable = { base: { observers: { [observer]: "unavailable", http: "on" } } };
    const report = reportWith([route("GET /products")], unavailable);
    expect(feedbackFor(report, context({ dependencies: new Set([dependency]) }))?.why).toBe(
      `the ${observer} observer was unavailable, and the project depends on ${dependency}`,
    );
  });

  it("offers it when an observer was unavailable in a project that depends on its driver, and not otherwise", () => {
    const unavailable = { base: { observers: { pg: "unavailable", http: "on", redis: "on", runtime: "on" } } };
    const report = reportWith([route("GET /products")], unavailable);
    expect(feedbackFor(report, context({ dependencies: new Set(["postgres"]) }))?.why).toBe(
      "the pg observer was unavailable, and the project depends on postgres",
    );
    expect(feedbackFor(report, context({ dependencies: new Set(["express"]) }))).toBeNull();
  });
});

describe("what the issue says", () => {
  const report = failed({
    failure: { code: "no-profile", side: "change", message: "the run left no profile", advice: null, outputTail: null },
    routes: [route("GET /tenants/:tenant/invoices", ["no-profile-in-change"]), route("POST /payroll", ["not-called"])],
  });
  const feedback = feedbackFor(report, context());
  const { body } = issueOf(feedback?.url ?? "");

  it("is a new issue on the public repository", () => {
    expect(feedback?.url.startsWith(`${ISSUES_URL}?`)).toBe(true);
  });

  it("says the versions, the known frameworks and data packages, the runner, and the codes, counted", () => {
    expect(body).toContain("| `@downtrace/agent` | 0.12.0 |");
    expect(body).toContain("| Node | v22.11.0 on linux |");
    expect(body).toContain("| Frameworks | express |");
    expect(body).toContain("| Data packages | pg |");
    // The script `npm test` runs, read for the runner's name.
    expect(body).toContain("| Test runner | vitest |");
    expect(body).toContain("| Failure | no-profile (change) |");
    expect(body).toContain("| Routes not evaluated | no-profile-in-change: 1, not-called: 1 |");
    expect(body).toContain("| Observers, base | no run |");
  });

  it("writes nothing of the code: no route, no command, no script, no package that is not a known one", () => {
    for (const secret of [
      "/tenants",
      "/payroll",
      "hunter2-zq",
      "db.internal",
      "DATABASE_URL",
      "secret-zq",
      "acme-internal-billing",
    ]) {
      expect(feedback?.url, secret).not.toContain(encodeURIComponent(secret));
      expect(body, secret).not.toContain(secret);
    }
  });

  it("is said in the text as a form nothing was sent through, and the JSON carries it as it is", () => {
    const text = renderText({ ...report, feedback });
    expect(text).toContain("Did Downtrace miss something? check could not compare (no-profile)");
    expect(text).toContain("Nothing was sent");
    expect(text).toContain(feedback?.url ?? "no url");
    expect(renderText(report)).not.toContain("Did Downtrace miss something?");
  });
});
