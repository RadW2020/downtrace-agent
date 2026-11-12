import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bodyOf, MARKER, syncComment } from "./comment.mjs";

/** What `downtrace check --json` prints (packages/agent/schema/check.schema.json), cut to what the comment reads. */
const operation = (over) => ({
  id: "query:n1",
  kind: "query",
  hash: "n1",
  label: "select name from authors where id = ?",
  change: "appeared",
  worse: true,
  judged: true,
  perRequest: { base: 0, change: 5 },
  sites: ["src/app.js:9"],
  ...over,
});
const route = (id, verdict, operations = []) => ({ id, verdict, operations });
const report = (routes, over = {}) => ({
  schema: "downtrace-check/1",
  status: "compared",
  summary: {
    worse: routes.filter((r) => r.verdict === "worse").length,
    unchanged: routes.filter((r) => r.verdict === "unchanged").length,
    notEvaluated: routes.filter((r) => r.verdict === "not-evaluated").length,
  },
  routes,
  base: { ref: "origin/main", commit: "9fb6e99ca1f0aa" },
  failure: null,
  ...over,
});
const worse = report([
  route("GET /posts", "worse", [
    operation(),
    operation({ id: "query:p", hash: "p", label: "select * from posts", change: "unchanged", worse: false }),
  ]),
  route("GET /health", "unchanged"),
]);
const clean = report([route("GET /posts", "unchanged")]);

test("the body names each route that got worse, the operation, its counts and where it ran", () => {
  const body = bodyOf(worse);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /1 route got worse/);
  assert.match(body, /`GET \/posts`/);
  assert.match(
    body,
    /appeared: `select name from authors where id = \?` · 0 → 5 per request · ran at `src\/app\.js:9`/,
  );
  assert.match(body, /`origin\/main` \(9fb6e99\): 1 worse, 1 unchanged, 0 not evaluated/);
});

test("the body lists only what got worse: no unchanged route, no operation that did not", () => {
  const body = bodyOf(worse);
  assert.doesNotMatch(body, /health/);
  assert.doesNotMatch(body, /select \* from posts/);
});

test("the body says so when no route got worse, and when no comparison was made", () => {
  assert.match(bodyOf(clean), /no route got worse/);
  const failed = report([], {
    status: "failed",
    summary: null,
    base: null,
    failure: {
      code: "command-failed",
      side: "base",
      message: "The test command failed on the base.",
      advice: "Run it.",
    },
  });
  const body = bodyOf(failed);
  assert.match(body, /no comparison/);
  assert.match(body, /The test command failed on the base\. Run it\./);
});

test("what the project wrote is shown as code and never as Markdown: a label with backticks, a mention, a newline", () => {
  const body = bodyOf(
    report([
      route("GET /p", "worse", [operation({ label: "select `a`,\n ``b`` from t -- @someone", sites: undefined })]),
    ]),
  );
  assert.match(body, /```select `a`, ``b`` from t -- @someone```/);
  assert.doesNotMatch(body, /ran at/);
});

test("a long label is cut, and an operation whose text did not travel is named by its id", () => {
  const body = bodyOf(
    report([
      route("GET /p", "worse", [operation({ label: "x".repeat(1000) }), operation({ id: "call:c1", label: null })]),
    ]),
  );
  assert.match(body, /`x{300}…`/);
  assert.match(body, /`call:c1`/);
});

test("a report it cannot read has no body", () => {
  assert.equal(bodyOf({ schema: "downtrace-check/2", status: "compared" }), null);
  assert.equal(bodyOf("not a report"), null);
});

/** A GitHub that holds comments, answers as the REST API does, and records what it was asked. */
function github(existing = []) {
  const comments = [...existing];
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.replace("https://api.test", "")}`);
    assert.equal(init.headers.authorization, "Bearer t0ken");
    assert.ok(init.signal instanceof AbortSignal, "every request carries a timeout");
    const json = (status, value) => ({ ok: status < 300, status, json: async () => value });
    if (method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(200, comments.slice((page - 1) * 100, page * 100));
    }
    const body = JSON.parse(init.body).body;
    if (method === "POST") comments.push({ id: comments.length + 1, body });
    else comments.find((comment) => url.endsWith(`/comments/${comment.id}`)).body = body;
    return json(method === "POST" ? 201 : 200, {});
  };
  return { fetch, calls, comments };
}
const at = { api: "https://api.test", repository: "o/r", pull: 7, token: "t0ken" };

test("the first run that finds a route worse posts one comment", async () => {
  const hub = github([{ id: 1, body: "somebody else's" }]);
  assert.equal(await syncComment(worse, { ...at, fetch: hub.fetch }), "posted");
  assert.deepEqual(hub.calls, [
    "GET /repos/o/r/issues/7/comments?per_page=100&page=1",
    "POST /repos/o/r/issues/7/comments",
  ]);
  assert.ok(hub.comments[1].body.startsWith(MARKER));
});

test("a later run updates that comment, and never posts a second one", async () => {
  const hub = github([{ id: 1, body: `${MARKER}\nold` }]);
  assert.equal(await syncComment(worse, { ...at, fetch: hub.fetch }), "updated");
  assert.equal(await syncComment(clean, { ...at, fetch: hub.fetch }), "updated");
  assert.equal(hub.comments.length, 1);
  assert.match(hub.comments[0].body, /no route got worse/);
  assert.ok(hub.calls.includes("PATCH /repos/o/r/issues/comments/1"));
});

test("a run with nothing worse posts nothing when there is no comment to update", async () => {
  const hub = github();
  assert.equal(await syncComment(clean, { ...at, fetch: hub.fetch }), "nothing to say");
  assert.equal(hub.comments.length, 0);
});

test("its comment is found past the first page of a long pull request", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, body: i === 120 ? `${MARKER}\nold` : "chat" }));
  const hub = github(many);
  assert.equal(await syncComment(worse, { ...at, fetch: hub.fetch }), "updated");
  assert.ok(hub.calls.includes("PATCH /repos/o/r/issues/comments/121"));
});

test("a GitHub that refuses is said, and not thrown past the check's own answer", async () => {
  const refuse = async () => ({ ok: false, status: 403, json: async () => ({ message: "Resource not accessible" }) });
  assert.equal(await syncComment(worse, { ...at, fetch: refuse }), "GitHub answered 403 to GET comments");
});

test("action.yml has no plain value with a colon and a space in it: the runner refuses the whole file", () => {
  const lines = readFileSync(new URL("./action.yml", import.meta.url), "utf8").split("\n");
  const broken = lines.filter((line) => /^\s*[\w-]+: [^"'>|#\s][^#]*: /.test(line));
  assert.deepEqual(broken, []);
});
