// The pull request's one comment: what `downtrace check --json` said, as Markdown, posted once and updated after.
//
//   node comment.mjs <report.json>
//
// It prints the comment, adds it to the job's summary, and keeps one comment on the pull request: posted the first
// time a route got worse, updated on every run after that. It never changes the job's result: the step that runs
// `check` exits with check's own status.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** How the comment is found again. Invisible in the rendered comment. */
export const MARKER = "<!-- downtrace-check -->";
const SCHEMA = "downtrace-check/1";
const MAX_LABEL = 300;
const MAX_PAGES = 10;
const TIMEOUT_MS = 15_000;

/**
 * What the project wrote (a route, a query, a file) as a code span. It is data and is shown as data: no Markdown in
 * it renders and no `@name` in it notifies anyone, whatever a query's text says.
 */
function code(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const cut = flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL)}…` : flat;
  const longest = Math.max(0, ...(cut.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = cut.startsWith("`") || cut.endsWith("`") ? " " : "";
  return `${fence}${pad}${cut}${pad}${fence}`;
}

const count = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2))));
const routes = (n) => `${n} route${n === 1 ? "" : "s"}`;

function operationLine(operation) {
  const { base, change } = operation.perRequest;
  const sites = operation.sites?.length > 0 ? ` · ran at ${operation.sites.map(code).join(", ")}` : "";
  return `- ${operation.change}: ${code(operation.label ?? operation.id)} · ${count(base)} → ${count(change)} per request${sites}`;
}

/** The comment's Markdown, or null for something that is not a report this reads. */
export function bodyOf(report) {
  if (report === null || typeof report !== "object" || report.schema !== SCHEMA) return null;
  if (report.status !== "compared") {
    const why = [report.failure?.message, report.failure?.advice].filter(Boolean).join(" ");
    return `${MARKER}\n### Downtrace: no comparison\n\n${why}\n`;
  }
  const worse = report.routes.filter((route) => route.verdict === "worse");
  const { summary, base } = report;
  const against = `${code(base.ref)}${base.commit ? ` (${base.commit.slice(0, 7)})` : ""}`;
  const totals = `${summary.worse} worse, ${summary.unchanged} unchanged, ${summary.notEvaluated} not evaluated`;
  const foot = `<sub>${code("downtrace check")} against ${against}: ${totals}.</sub>\n`;
  if (worse.length === 0) return `${MARKER}\n### Downtrace: no route got worse\n\n${foot}`;
  const blocks = worse.map((route) =>
    [`**${code(route.id)}**`, ...route.operations.filter((operation) => operation.worse).map(operationLine)].join("\n"),
  );
  return `${MARKER}\n### Downtrace: ${routes(worse.length)} got worse\n\n${blocks.join("\n\n")}\n\n${foot}`;
}

/**
 * Keeps the one comment: updates the one that carries the marker, or posts it when a route got worse and there is
 * none. Returns what it did, or what GitHub refused, as a sentence; it never throws for a refusal.
 */
export async function syncComment(report, { api, repository, pull, token, fetch }) {
  const body = bodyOf(report);
  if (body === null) return "not a report this action reads";
  const call = async (what, path, init = {}) => {
    const response = await fetch(`${api}/repos/${repository}/issues/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${what}`);
    return response.json();
  };
  try {
    let mine;
    for (let page = 1; page <= MAX_PAGES && mine === undefined; page++) {
      const comments = await call("GET comments", `${pull}/comments?per_page=100&page=${page}`);
      mine = comments.find((comment) => typeof comment.body === "string" && comment.body.startsWith(MARKER));
      if (comments.length < 100) break;
    }
    const send = { body: JSON.stringify({ body }) };
    if (mine !== undefined) {
      await call("PATCH comment", `comments/${mine.id}`, { method: "PATCH", ...send });
      return "updated";
    }
    const worse = report.status === "compared" && report.routes.some((route) => route.verdict === "worse");
    if (!worse) return "nothing to say";
    await call("POST comment", `${pull}/comments`, { method: "POST", ...send });
    return "posted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(file, env) {
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.log("::warning::downtrace check printed no JSON to comment on: see its output above.");
    return;
  }
  const body = bodyOf(report);
  if (body === null) {
    console.log("::warning::downtrace check printed a report this action does not read; update the action.");
    return;
  }
  console.log(body);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body);
  let pull;
  try {
    pull = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request?.number;
  } catch {
    pull = undefined;
  }
  if (!Number.isInteger(pull) || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    console.log("Not a pull request, or no token: no comment.");
    return;
  }
  const did = await syncComment(report, {
    api: env.GITHUB_API_URL || "https://api.github.com",
    repository: env.GITHUB_REPOSITORY,
    pull,
    token: env.GITHUB_TOKEN,
    fetch: globalThis.fetch,
  });
  const known = ["posted", "updated", "nothing to say"].includes(did);
  console.log(known ? `Comment: ${did}.` : `::warning::The comment was not written: ${did}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv[2], process.env);
}
