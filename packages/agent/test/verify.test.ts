import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { DESTINATION_PATH } from "@downtrace/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../src/check/args.ts";
import { runCli } from "../src/check/command.ts";
import { runVerify, type VerifyDeps } from "../src/verify.ts";
import { REGISTER_URL } from "./support/check-project.ts";

/**
 * `downtrace verify` checks a token without sending data (RF-507): it asks the cloud where the token writes, and says
 * it, or which of the things that can go wrong did. In a pilot integration the only way to know was to post `{}` to
 * the ingestion path and read the status.
 */

const TOKEN = "dt_0123456789abcdef0123456789abcdef0123456789abcdef";

/** A cloud on a port of its own that answers the check with `answer`, and remembers what it was asked. */
interface Cloud {
  url: string;
  asked: { method: string | undefined; url: string | undefined; authorization: string | undefined }[];
}
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

async function cloud(answer: (req: IncomingMessage) => { status: number; body?: string } | "never"): Promise<Cloud> {
  const asked: Cloud["asked"] = [];
  const server = createServer((req, res) => {
    asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const a = answer(req);
    if (a === "never") return; // takes the request and never answers
    res.writeHead(a.status, { "content-type": "application/json" }).end(a.body ?? "");
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

/** A port nothing listens on: one a server had, and gave back. */
async function nobody(): Promise<string> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}`;
}

async function verify(over: Partial<VerifyDeps>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runVerify({
    dsn: undefined,
    token: undefined,
    url: undefined,
    env: {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    signal: undefined,
    ...over,
  });
  const all = [...out, ...err].join("");
  return { code, stdout: out.join(""), stderr: err.join(""), all };
}

const writesTo = (destination: object) => () => ({ status: 200, body: JSON.stringify(destination) });

describe("downtrace verify", () => {
  it("prints the project and the environment, exits 0, and sends no batch", async () => {
    const c = await cloud(writesTo({ project: "shop-api", environment: "staging" }));
    const { code, stdout, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: `${c.url}/` } });
    expect(stderr).toBe("");
    expect(stdout).toBe("downtrace verify: the token writes to shop-api / staging\n");
    expect(code).toBe(0);
    // One check, with the token as a bearer, and nothing posted: no batch, nothing ingested.
    expect(c.asked).toEqual([{ method: "GET", url: DESTINATION_PATH, authorization: `Bearer ${TOKEN}` }]);
  });

  it("says a token that names no environment writes to the one each batch declares", async () => {
    const c = await cloud(writesTo({ project: "shop-api" }));
    const { code, stdout } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url } });
    expect(stdout).toBe(
      "downtrace verify: the token writes to shop-api, in the environment each batch declares (DOWNTRACE_ENV)\n",
    );
    expect(code).toBe(0);
  });

  it("says the token was refused, exits 1, and never echoes it", async () => {
    const c = await cloud(() => ({ status: 401, body: '{"error":"unknown token"}' }));
    const { code, stderr, all } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url } });
    expect(stderr).toBe(
      `downtrace verify: the cloud at ${c.url} refused the token (401): it does not know it, or it was revoked\n`,
    );
    expect(code).toBe(1);
    expect(all).not.toContain(TOKEN.slice(3));
  });

  it("says the cloud could not be reached, exits 2, with no stack trace", async () => {
    const url = await nobody();
    const { code, stdout, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: url } });
    expect(stdout).toBe("");
    expect(stderr).toMatch(new RegExp(`^downtrace verify: could not reach the cloud at ${url}: .+\\n$`));
    expect(stderr).not.toMatch(/\n\s+at /);
    expect(code).toBe(2);
  });

  it("says the cloud did not answer in time, exits 2", async () => {
    const c = await cloud(() => "never");
    const { code, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url }, timeoutMs: 50 });
    expect(stderr).toBe(`downtrace verify: the cloud at ${c.url} did not answer within 0.05 s\n`);
    expect(code).toBe(2);
  });

  it("says a cloud with no check is older than it, or is not a Downtrace cloud, and exits 2", async () => {
    const c = await cloud(() => ({ status: 404, body: "404 page not found" }));
    const { code, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url } });
    expect(stderr).toBe(
      `downtrace verify: the cloud at ${c.url} cannot check a token (404): it is older than protocol 0.14.0, or it is not a Downtrace cloud\n`,
    );
    expect(code).toBe(2);
  });

  it("says what any other answer was, and exits 2", async () => {
    for (const [status, says] of [
      [429, "asked to wait (429): too many failed attempts from this address, or this token's rate is spent"],
      [503, "answered 503"],
    ] as const) {
      const c = await cloud(() => ({ status }));
      const { code, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url } });
      expect(stderr).toBe(`downtrace verify: the cloud at ${c.url} ${says}\n`);
      expect(code).toBe(2);
    }
  });

  it("refuses an answer that is not a destination it can print, and exits 2", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ project: "shop\u001b[2J", environment: "staging" })]) {
      const c = await cloud(() => ({ status: 200, body }));
      const { code, stdout, stderr } = await verify({ env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url } });
      expect(stdout, body).toBe("");
      expect(stderr, body).toBe(
        `downtrace verify: the cloud at ${c.url} answered 200 with something that is not a destination\n`,
      );
      expect(code, body).toBe(2);
    }
  });

  it("reads the token from a DSN, as the instrumentation does, and never echoes the DSN", async () => {
    const c = await cloud(writesTo({ project: "shop-api", environment: "production" }));
    const dsn = c.url.replace("http://", `http://${TOKEN}@`);
    const { code, stdout, all } = await verify({ env: { DOWNTRACE_DSN: dsn } });
    expect(stdout).toBe("downtrace verify: the token writes to shop-api / production\n");
    expect(code).toBe(0);
    expect(c.asked[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(all).not.toContain(TOKEN.slice(3));
  });

  it("takes the token from its flags, over the environment's", async () => {
    const c = await cloud(writesTo({ project: "shop-api", environment: "staging" }));
    const elsewhere = await nobody();
    const env = { DOWNTRACE_DSN: elsewhere.replace("http://", "http://dt_other@") };
    const byToken = await verify({ token: TOKEN, url: c.url, env });
    expect(byToken.code).toBe(0);
    const byDsn = await verify({ dsn: c.url.replace("http://", `http://${TOKEN}@`), env });
    expect(byDsn.code).toBe(0);
    expect(c.asked.map((a) => a.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("says what to set when there is nothing to check, and exits 2", async () => {
    const none = await verify({ env: {} });
    expect(none.stderr).toBe(
      "downtrace verify: nothing to check: DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL; or pass --dsn, or --token and --url\n",
    );
    expect(none.code).toBe(2);
    const inspecting = await verify({ env: { DOWNTRACE_INSPECT: "stderr" } });
    expect(inspecting.stderr).toMatch(/^downtrace verify: nothing to check: no cloud is set, only DOWNTRACE_INSPECT/);
    expect(inspecting.code).toBe(2);
    const badUrl = await verify({ token: TOKEN, url: "cloud.example.com" });
    expect(badUrl.stderr).toBe("downtrace verify: --url must start with http:// or https://\n");
    expect(badUrl.code).toBe(2);
    const badDsn = await verify({ dsn: "not a dsn" });
    expect(badDsn.stderr).toMatch(/^downtrace verify: --dsn is not a URL/);
    expect(badDsn.all).not.toContain("not a dsn");
    expect(badDsn.code).toBe(2);
  });
});

describe("downtrace verify, from the command line", () => {
  it("reads its flags", () => {
    expect(parseArgs(["verify"])).toEqual({ kind: "verify", dsn: undefined, token: undefined, url: undefined });
    expect(parseArgs(["verify", "--token", "t", "--url=https://c.example"])).toEqual({
      kind: "verify",
      dsn: undefined,
      token: "t",
      url: "https://c.example",
    });
    expect(parseArgs(["verify", "--dsn", "https://t@c.example"])).toMatchObject({ dsn: "https://t@c.example" });
    expect(parseArgs(["verify", "--help"])).toEqual({ kind: "help" });
    expect(USAGE).toContain("downtrace verify [--dsn <dsn> | --token <token> --url <url>]");
  });

  it.each([
    [["verify", "--token"], "--token needs a value"],
    [["verify", "--token", "t"], "--token and --url go together"],
    [["verify", "--url", "https://c.example"], "--token and --url go together"],
    [
      ["verify", "--dsn", "https://t@c.example", "--token", "t", "--url", "https://c.example"],
      "--dsn, or --token and --url, not both",
    ],
    [["verify", "--frobnicate"], "unknown option --frobnicate for verify"],
    [["verify", "shop-api"], 'unexpected "shop-api": verify reads the token from the environment or its flags'],
  ])("says what is wrong with %j", (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" ? parsed.message : "").toContain(message);
  });

  it("runs as `downtrace verify`, with the environment the command was given", async () => {
    const c = await cloud(writesTo({ project: "shop-api", environment: "staging" }));
    const out: string[] = [];
    const code = await runCli({
      argv: ["verify"],
      env: { DOWNTRACE_TOKEN: TOKEN, DOWNTRACE_URL: c.url },
      cwd: tmpdir(),
      tmpRoot: tmpdir(),
      registerUrl: REGISTER_URL,
      version: "9.9.9",
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      signal: undefined,
    });
    expect(out.join("")).toBe("downtrace verify: the token writes to shop-api / staging\n");
    expect(code).toBe(0);
  });
});
