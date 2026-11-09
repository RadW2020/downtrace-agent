import { afterEach, describe, expect, it } from "vitest";
import { runRead } from "../src/read.ts";
import { type Answer, aHome, cleanUp, json, type StandIn, standIn, stored } from "./support/stand-in-cloud.ts";

/**
 * `downtrace api <path>` against a stand-in cloud: it reads one path of a project's API, such as each item of a brief
 * names, and prints the answer as it came. It only reads, and only from the cloud configured: anything else is refused
 * before a request is sent, and the stand-in shows none was.
 */

afterEach(cleanUp);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function api(argv: string[], cloud: StandIn, home: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRead({
    command: "api",
    argv,
    env: { DOWNTRACE_URL: cloud.url, ...env },
    home,
    uid: process.getuid?.(),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
    now: () => Date.parse("2026-11-09T16:00:00Z"),
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** A cloud that answers every path, and a home whose file holds a credential of each project for it. */
async function connected(answer: (path: string) => Answer = () => json(200, { ok: true })) {
  const cloud = await standIn(answer);
  const home = await aHome();
  await stored(home, [
    { url: cloud.url, project: "nidus-api", token: "dtr_nidus" },
    { url: cloud.url, project: "shop-api", token: "dtr_shop" },
  ]);
  return { cloud, home };
}

describe("downtrace api", () => {
  it("reads each path a brief's next gives, as written, and prints the answer as it came", async () => {
    // covers: RF-525
    // The paths the cloud's brief names: a finding's report, an error, a route's status and what changed since.
    const paths = [
      "/api/p/nidus-api/findings/42/report",
      "/api/p/nidus-api/errors/9f3c0a",
      "/api/p/nidus-api/status?method=GET&operations=hash&route=%2Forders%2F%3Aid",
      "/api/p/nidus-api/status?operations=none",
      "/api/p/nidus-api/changes?since=2026-11-09T16%3A04%3A00Z",
    ];
    const body = '{"version":"v1","items":[1, 2]}';
    const { cloud, home } = await connected(() => ({ status: 200, body }));
    for (const path of paths) {
      const run = await api([path], cloud, home);
      expect(run, path).toEqual({ code: 0, stdout: `${body}\n`, stderr: "" });
    }
    expect(cloud.seen).toEqual(paths.map((path) => ({ method: "GET", path, authorization: "Bearer dtr_nidus" })));
  });

  it("sends the credential of the project the path is of, and no other", async () => {
    // covers: RF-611
    const { cloud, home } = await connected();
    expect((await api(["/api/p/shop-api/findings"], cloud, home)).code).toBe(0);
    expect(cloud.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_shop"]);
    const none = await api(["/api/p/other-api/findings"], cloud, home);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("stored no credential for other-api");
    expect(cloud.seen).toHaveLength(1);
    // DOWNTRACE_TOKEN, when it is set, is the one sent.
    expect((await api(["/api/p/other-api/findings"], cloud, home, { DOWNTRACE_TOKEN: "dtr_env" })).code).toBe(0);
    expect(cloud.seen.map((r) => r.authorization)).toEqual(["Bearer dtr_shop", "Bearer dtr_env"]);
  });

  it("reads an absolute URL on the cloud configured, and --json changes nothing of an answer", async () => {
    // covers: RF-525
    const { cloud, home } = await connected();
    const run = await api([`${cloud.url}/api/p/nidus-api/brief?since=2026-11-09T15%3A00%3A00Z`, "--json"], cloud, home);
    expect(run).toEqual({ code: 0, stdout: '{"ok":true}\n', stderr: "" });
    expect(cloud.seen.map((r) => r.path)).toEqual(["/api/p/nidus-api/brief?since=2026-11-09T15%3A00%3A00Z"]);
  });

  it("reads under the path of a cloud that is served under one", async () => {
    const { cloud, home } = await connected();
    await stored(home, [{ url: `${cloud.url}/downtrace`, project: "nidus-api", token: "dtr_under" }]);
    const out: string[] = [];
    const code = await runRead({
      command: "api",
      argv: [`${cloud.url}/downtrace/api/p/nidus-api/findings`],
      env: { DOWNTRACE_URL: `${cloud.url}/downtrace/` },
      home,
      uid: process.getuid?.(),
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      signal: undefined,
      now: () => Date.parse("2026-11-09T16:00:00Z"),
    });
    expect(code, out.join("")).toBe(0);
    expect(cloud.seen).toEqual([
      { method: "GET", path: "/downtrace/api/p/nidus-api/findings", authorization: "Bearer dtr_under" },
    ]);
  });

  it("says the cloud's refusal in its own words, and exits 1", async () => {
    // covers: RF-525
    const { cloud, home } = await connected(() => json(404, { error: "no such finding" }));
    const run = await api(["/api/p/nidus-api/findings/7"], cloud, home);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`downtrace api: the cloud at ${cloud.url} answered 404: no such finding\n`);
  });

  it("exits 2 for an answer that is not JSON, and prints nothing of it", async () => {
    const { cloud, home } = await connected(() => ({ status: 200, body: "<html>" }));
    const run = await api(["/api/p/nidus-api/status"], cloud, home);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
  });
});

describe("what downtrace api refuses before sending anything", () => {
  it.each([
    // Another origin, or the same host on another port or scheme, or with credentials of its own in the URL.
    ["https://elsewhere.example/api/p/nidus-api/brief", "is not on the cloud at"],
    ["http://127.0.0.1:9/api/p/nidus-api/brief", "is not on the cloud at"],
    ["//elsewhere.example/api/p/nidus-api/brief", "is not a path under /api/p/<slug>/"],
    // Outside a project's API.
    ["/api/credential", "is not a path under /api/p/<slug>/"],
    ["/api/projects", "is not a path under /api/p/<slug>/"],
    ["/login/device/code", "is not a path under /api/p/<slug>/"],
    ["/api/p/nidus-api", "is not a path under /api/p/<slug>/"],
    ["/api/p/nidus-api/", "is not a path under /api/p/<slug>/"],
    ["/api/p//brief", "is not a path under /api/p/<slug>/"],
    ["api/p/nidus-api/brief", "is not a path under /api/p/<slug>/"],
    ["/API/p/nidus-api/brief", "is not a path under /api/p/<slug>/"],
    // Dot segments and separators hidden in escapes, which would resolve out of it.
    ["/api/p/nidus-api/../../credential", "resolved"],
    ["/api/p/nidus-api/./brief", "resolved"],
    ["/api/p/nidus-api/%2e%2e/%2E%2E/credential", "resolved"],
    ["/api/p/nidus-api/.%2e/x", "resolved"],
    ["/api/p/%2e%2e/projects/x", "resolved"],
    ["/api/p/nidus-api/..%2f..%2fcredential", "resolved"],
    ["/api/p/nidus-api/x%5c..%5ccredential", "resolved"],
    ["/api/p/nidus%2Fapi/brief", "resolved"],
    ["/api/p/nidus-api/%zz", "an escape that is not one"],
    ["/api/p/nidus-api/..\\..\\credential", "a backslash"],
    ["/api/p/nidus-api/brief#x", "a fragment"],
    ["/api/p/nidus-api/brief x", "a space"],
    ["/api/p/nidus-api/brief\u0000", "a control character"],
  ])("%j", async (path, says) => {
    // covers: RF-525
    const { cloud, home } = await connected();
    const run = await api([path], cloud, home);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(says);
    expect(run.stdout).toBe("");
    expect(cloud.seen).toEqual([]);
  });

  it("refuses another origin that shares the cloud's host, or carries a user and password", async () => {
    // covers: RF-525
    const { cloud, home } = await connected();
    const host = new URL(cloud.url).host;
    for (const url of [`https://${host}/api/p/nidus-api/brief`, `http://u:p@${host}/api/p/nidus-api/brief`]) {
      const run = await api([url], cloud, home);
      expect(run.code, url).toBe(2);
      expect(run.stderr, url).toContain("is not on the cloud at");
    }
    expect(cloud.seen).toEqual([]);
  });

  it("sends GET and nothing else: it takes no method", async () => {
    // covers: RF-525
    const { cloud, home } = await connected();
    for (const [argv, says] of [
      [["--method", "POST", "/api/p/nidus-api/findings/1/close"], "unknown option --method for api"],
      [["-X", "DELETE", "/api/p/nidus-api/silences/1"], "unknown option -X for api"],
      [["--method=GET", "/api/p/nidus-api/brief"], "unknown option --method=GET for api"],
      [["POST", "/api/p/nidus-api/findings/1/close"], "api reads one path"],
    ] as const) {
      const run = await api([...argv], cloud, home);
      expect(run.code, argv.join(" ")).toBe(2);
      expect(run.stderr, argv.join(" ")).toContain(says);
      // The usage it prints says why.
      expect(run.stderr, argv.join(" ")).toMatch(/It\s+sends GET and nothing else/);
    }
    expect(cloud.seen).toEqual([]);
  });

  it.each([
    [[], "api reads one path"],
    [["/api/p/nidus-api/brief", "/api/p/nidus-api/status"], "api reads one path"],
    [["--project", "x", "/api/p/x/brief"], "unknown option --project for api"],
    [["--url"], "--url needs a value"],
  ])("refuses %j with its usage", async (argv, says) => {
    const { cloud, home } = await connected();
    const run = await api(argv, cloud, home);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(says);
    expect(run.stderr).toContain("Usage: downtrace");
    expect(cloud.seen).toEqual([]);
  });
});
