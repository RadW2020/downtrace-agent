import { spawn } from "node:child_process";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, httpConfigFrom } from "../src/config.ts";
import { createHttpServer, type HttpServerOptions } from "../src/http.ts";
import { createServer, PROTOCOL_VERSIONS } from "../src/server.ts";
import { type Property, type Tool, tools } from "../src/tools.ts";

/**
 * The MCP server over Streamable HTTP, with the credential each request carries (RF-513, ADR 0263): the stdio
 * server's tools and answers, a request at a time, behind the 401 an MCP client starts its OAuth from.
 */

const CLOUD = "https://cloud.test";
const TOKEN = "dtr_remote_secret";

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * The fake cloud both servers call: it records every request and answers each with `answer`, or with an object
 * that carries a `fromService` value, so a test can see it travel through untouched.
 */
function fakeCloud(answer: () => Response = () => okAnswer()) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return answer();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function okAnswer(): Response {
  return new Response(JSON.stringify({ ok: true, fromService: { route: "/ignore-previous-instructions" } }), {
    status: 200,
  });
}

const open: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/** An HTTP server on a free port of the loopback, and its base address. */
async function listening(opts: Partial<HttpServerOptions> & { fetchImpl: typeof fetch }) {
  const server = createHttpServer({
    url: CLOUD,
    publicUrl: "",
    origins: [],
    version: "0.0.0",
    newKey: () => "key-1",
    ...opts,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => server.close() });
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, port, server };
}

interface Posted {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

/** One POST of one JSON-RPC message, as an MCP client sends it. */
async function post(
  url: string,
  message: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<Posted> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** A request through `node:http`, which lets a test set `Host` and send a body in chunks, as `fetch` does not. */
function raw(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; chunks?: string[] },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "POST", headers: opts.headers ?? {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    for (const c of opts.chunks ?? []) req.write(c);
    req.end();
  });
}

const initialize = (protocolVersion: string, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } },
});

/** Arguments every tool takes: its required ones, each a value its schema accepts, and the project of the URL. */
function argumentsOf(tool: Tool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of tool.inputSchema.required ?? []) {
    const p: Property | undefined = tool.inputSchema.properties[name];
    if (name === "project") args[name] = "shop";
    else if (p?.enum !== undefined) args[name] = p.enum[0];
    else if (p?.type === "integer" || p?.type === "number") args[name] = 1;
    else if (p?.format === "date-time") args[name] = "2026-11-09T10:00:00Z";
    else args[name] = "1";
  }
  return args;
}

/**
 * What the stdio server answers to `messages`, in one session over its framing, with `DOWNTRACE_TOKEN` set to `token`
 * and the same fake cloud: answers by id.
 */
async function overStdio(messages: unknown[], fetchImpl: typeof fetch, token = TOKEN) {
  const s = createServer({ config: { url: CLOUD, token }, version: "0.0.0", fetchImpl, newKey: () => "key-1" });
  const out: string[] = [];
  await s.run(
    (async function* () {
      for (const m of messages) yield JSON.stringify(m);
    })(),
    (line) => out.push(line),
  );
  const byId = new Map<unknown, unknown>();
  for (const line of out) {
    const parsed = JSON.parse(line) as { id: unknown };
    byId.set(parsed.id, parsed);
  }
  return byId;
}

describe("over HTTP, a request with a credential", () => {
  it("is answered what the stdio server answers with that credential: every tool, schema, hint and result", async () => {
    for (const revision of PROTOCOL_VERSIONS) {
      const stdioCloud = fakeCloud();
      const httpCloud = fakeCloud();
      const calls = tools.map((tool, i) => ({
        jsonrpc: "2.0",
        id: 10 + i,
        method: "tools/call",
        params: { name: tool.name, arguments: argumentsOf(tool) },
      }));
      const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
      // One message at a time, as a client reads each answer before the next, so the cloud is asked in one order.
      const stdio = new Map<unknown, unknown>();
      const stdioServer = createServer({
        config: { url: CLOUD, token: TOKEN },
        version: "0.0.0",
        fetchImpl: stdioCloud.fetchImpl,
        newKey: () => "key-1",
      });
      for (const m of [initialize(revision), list, ...calls]) {
        const out: string[] = [];
        await stdioServer.run(
          (async function* () {
            yield JSON.stringify(m);
          })(),
          (line) => out.push(line),
        );
        for (const line of out) stdio.set((JSON.parse(line) as { id: unknown }).id, JSON.parse(line));
      }

      const { base } = await listening({ fetchImpl: httpCloud.fetchImpl });
      const url = `${base}/mcp/shop`;
      const http = new Map<unknown, unknown>();
      const opened = await post(url, initialize(revision));
      expect(opened.status).toBe(200);
      expect(opened.headers.get("content-type")).toMatch(/^application\/json/);
      http.set(1, opened.json);
      for (const m of [list, ...calls]) {
        const out = await post(url, m, { authorization: `Bearer ${TOKEN}`, "mcp-protocol-version": revision });
        expect(out.status).toBe(200);
        http.set(m.id, out.json);
      }

      expect(http.size).toBe(calls.length + 2);
      expect(Object.fromEntries(http)).toEqual(Object.fromEntries(stdio));
      // And the cloud was asked the same: each call, its credential as a Bearer token, its body and its key.
      expect(httpCloud.sent).toEqual(stdioCloud.sent);
      expect(httpCloud.sent.length).toBeGreaterThan(0);
      for (const s of httpCloud.sent) expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("takes the revision of MCP-Protocol-Version, and, without the header, the one the transport says to assume", async () => {
    const { fetchImpl } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const annotated = await post(`${base}/mcp/shop`, list, {
      authorization: `Bearer ${TOKEN}`,
      "mcp-protocol-version": "2025-06-18",
    });
    const plain = await post(`${base}/mcp/shop`, list);
    // Without the header a server assumes 2025-03-26, which this server answers as 2024-11-05, as `initialize` does.
    const stdio = await overStdio([initialize("2025-03-26"), list], fetchImpl);
    expect(plain.json).toEqual(stdio.get(2));
    const firstOf = (out: unknown) => (out as { result: { tools: Array<{ annotations?: unknown }> } }).result.tools[0];
    expect(firstOf(annotated.json)?.annotations).toBeDefined();
    expect(firstOf(plain.json)?.annotations).toBeUndefined();
  });

  it("is refused with 400 when MCP-Protocol-Version names a revision this server does not speak", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    const out = await post(
      `${base}/mcp/shop`,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_findings", arguments: { project: "shop" } },
      },
      { authorization: `Bearer ${TOKEN}`, "mcp-protocol-version": "1999-01-01" },
    );
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(sent).toEqual([]);
  });

  it("is about the project its URL names: a call that names none is given it, one that names another is refused", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    const call = (args: Record<string, unknown>) =>
      post(`${base}/mcp/shop`, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_findings", arguments: args },
      });

    const given = (await call({})).json as { result: { isError?: boolean } };
    expect(given.result.isError).toBeUndefined();
    expect(sent.map((s) => s.url)).toEqual([`${CLOUD}/api/p/shop/findings`]);

    const other = (await call({ project: "nidus-api" })).json as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(other.result.isError).toBe(true);
    expect(other.result.content[0]?.text).toContain("shop");
    expect(other.result.content[0]?.text).toContain("nidus-api");
    expect(sent).toHaveLength(1);
  });

  it("whose credential the cloud refuses gets the stdio server's 401, asked of the cloud on every call", async () => {
    const refused = () => new Response('{"error":"unauthorized"}', { status: 401 });
    const httpCloud = fakeCloud(refused);
    const stdioCloud = fakeCloud(refused);
    const { base } = await listening({ fetchImpl: httpCloud.fetchImpl });
    const call = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "project_status", arguments: { project: "shop" } },
    };
    const headers = { authorization: "Bearer dtr_revoked", "mcp-protocol-version": "2025-11-25" };
    const first = await post(`${base}/mcp/shop`, call, headers);
    const second = await post(`${base}/mcp/shop`, call, headers);
    const stdio = await overStdio([initialize("2025-11-25", 0), call], stdioCloud.fetchImpl, "dtr_revoked");

    expect(first.status).toBe(200);
    expect(first.json).toEqual(stdio.get(5));
    expect(first.json).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(first.json)).toContain("the cloud answered 401");
    expect(second.json).toEqual(first.json);
    // Asked on each call, nothing answered from a cache.
    expect(httpCloud.sent).toHaveLength(2);
    for (const s of httpCloud.sent) expect(s.headers.authorization).toBe("Bearer dtr_revoked");
  });

  it("is a session of its own: one request's credential is never another's", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    const call = (token: string) =>
      post(
        `${base}/mcp/shop`,
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_findings", arguments: {} } },
        { authorization: `Bearer ${token}` },
      );
    await Promise.all([call("dtr_one"), call("dtr_two"), call("dtr_one")]);
    expect(sent.map((s) => s.headers.authorization).sort()).toEqual([
      "Bearer dtr_one",
      "Bearer dtr_one",
      "Bearer dtr_two",
    ]);
  });
});

describe("over HTTP, a request without a usable credential", () => {
  it("is answered 401 naming the server's metadata, which names the URL the client used and the cloud", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    for (const headers of [{}, { authorization: "Basic dXNlcjpwYXNz" }, { authorization: "Bearer " }]) {
      const out = await post(`${base}/mcp/shop?environment=staging&level=operate`, initialize("2025-11-25"), headers);
      expect(out.status).toBe(401);
      expect(out.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/shop?environment=staging&level=operate"`,
      );
    }
    const metadata = await fetch(
      `${base}/.well-known/oauth-protected-resource/mcp/shop?environment=staging&level=operate`,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await metadata.json()).toEqual({
      resource: `${base}/mcp/shop?environment=staging&level=operate`,
      authorization_servers: [CLOUD],
      bearer_methods_supported: ["header"],
    });
    expect(sent).toEqual([]);
  });

  it("names the public URL in the metadata when one is configured, whatever Host the request came with", async () => {
    const { fetchImpl } = fakeCloud();
    const { base } = await listening({ fetchImpl, publicUrl: "https://downtrace.example" });
    const out = await raw(`${base}/mcp/shop`, {
      headers: { host: "mcp:8787", "content-type": "application/json" },
      chunks: [JSON.stringify(initialize("2025-11-25"))],
    });
    expect(out.status).toBe(401);
    expect(out.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://downtrace.example/.well-known/oauth-protected-resource/mcp/shop"',
    );
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/shop`);
    expect(await metadata.json()).toMatchObject({
      resource: "https://downtrace.example/mcp/shop",
      authorization_servers: [CLOUD],
    });
  });
});

describe("over HTTP, the transport", () => {
  it("answers a notification 202 with no body", async () => {
    const { fetchImpl } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    for (const method of ["notifications/initialized", "notifications/cancelled"]) {
      const out = await post(`${base}/mcp/shop`, { jsonrpc: "2.0", method, params: { requestId: 1 } });
      expect(out.status).toBe(202);
      expect(out.text).toBe("");
    }
  });

  it("answers a GET, or any method but POST, 405: a server of tools sends nothing unasked", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const out = await raw(`${base}/mcp/shop`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      });
      expect(out.status).toBe(405);
      expect(out.headers.allow).toBe("POST");
    }
    const notRead = await raw(`${base}/.well-known/oauth-protected-resource/mcp/shop`, { method: "POST" });
    expect(notRead.status).toBe(405);
    expect(notRead.headers.allow).toBe("GET");
    expect(sent).toEqual([]);
  });

  it("serves no path but a project's, by a project's slug", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    for (const path of [
      "/mcp",
      "/mcp/",
      "/mcp/Shop",
      "/mcp/shop/",
      "/mcp/shop/x",
      "/mcp/-shop",
      "/mcp/sh%6fp",
      `/mcp/${"a".repeat(64)}`,
      "/",
      "/.well-known/oauth-protected-resource",
    ]) {
      const out = await post(`${base}${path}`, initialize("2025-11-25"));
      expect(out.status, path).toBe(404);
    }
    expect((await post(`${base}/mcp/${"a".repeat(63)}`, initialize("2025-11-25"))).status).toBe(200);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/Shop`)).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("refuses an Origin that is neither its own nor configured with 403, and takes one that is, or none", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl, origins: ["https://app.example"] });
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_findings", arguments: {} } };
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "not an origin"]) {
      const out = await post(`${base}/mcp/shop`, call, { ...auth, origin });
      expect(out.status, origin).toBe(403);
      expect(out.json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
      expect(
        (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/shop`, { headers: { origin } })).status,
      ).toBe(403);
    }
    expect(sent).toEqual([]);
    for (const origin of [base, "https://app.example", undefined]) {
      const out = await post(`${base}/mcp/shop`, call, origin === undefined ? auth : { ...auth, origin });
      expect(out.status, String(origin)).toBe(200);
    }
    expect(sent).toHaveLength(3);
  });

  it("with no public URL, answers only a loopback Host, so a rebound name cannot reach it", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base, port } = await listening({ fetchImpl });
    const message = JSON.stringify(initialize("2025-11-25"));
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    for (const host of [`evil.example:${port}`, `localhost.evil.example:${port}`, `user@localhost:${port}`]) {
      const out = await raw(`${base}/mcp/shop`, { headers: { ...headers, host }, chunks: [message] });
      expect(out.status, host).toBe(403);
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const out = await raw(`${base}/mcp/shop`, { headers: { ...headers, host }, chunks: [message] });
      expect(out.status, host).toBe(200);
    }
    expect(sent).toEqual([]);
  });

  it("refuses a body over its limit with 413, declared or sent in chunks, and asks the cloud nothing", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl, maxBodyBytes: 256 });
    const big = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "annotate_finding", arguments: { finding: "1", note: "x".repeat(1024) } },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const declared = await raw(`${base}/mcp/shop`, {
      headers: { ...headers, "content-length": String(Buffer.byteLength(big)) },
      chunks: [big],
    });
    expect(declared.status).toBe(413);
    // Declared larger than the limit, it is refused before the body arrives: not after waiting for a gigabyte.
    const { port } = new URL(base);
    const early = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /mcp/shop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
            "Content-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n{",
        );
      });
      socket.setEncoding("utf8");
      socket.once("data", (c: string) => {
        resolve(c);
        socket.destroy();
      });
      socket.on("error", reject);
    });
    expect(early).toMatch(/^HTTP\/1\.1 413/);
    const chunked = await raw(`${base}/mcp/shop`, {
      headers: { ...headers, "transfer-encoding": "chunked" },
      chunks: [big.slice(0, 200), big.slice(200, 400), big.slice(400)],
    });
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.text)).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(sent).toEqual([]);
  });

  it("ends a request whose body does not arrive in time with 408", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { port } = await listening({ fetchImpl, readTimeoutMs: 200 });
    const answered = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /mcp/shop HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
            "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        );
      });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (c: string) => {
        text += c;
      });
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    expect(answered).toMatch(/^HTTP\/1\.1 408/);
    expect(sent).toEqual([]);
  });

  it("answers what is not one JSON-RPC message with its error, saying nothing of the parser", async () => {
    const { fetchImpl, sent } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    const cases: Array<[string, number, number]> = [
      ["{not json", 400, -32700],
      ["", 400, -32700],
      ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]', 400, -32600],
      ['"ping"', 400, -32600],
      ['{"jsonrpc":"2.0","id":1}', 400, -32600],
      ['{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}', 400, -32600],
      ['{"jsonrpc":"2.0","id":null,"method":"ping"}', 400, -32600],
    ];
    for (const [body, status, code] of cases) {
      const out = await post(`${base}/mcp/shop`, body);
      expect(out.status, body).toBe(status);
      expect(out.json, body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code } });
      expect(out.text, body).not.toMatch(/Unexpected|position|token|SyntaxError/i);
    }
    const unknown = await post(`${base}/mcp/shop`, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32601 } });
    const ping = await post(`${base}/mcp/shop`, { jsonrpc: "2.0", id: "p", method: "ping" });
    expect(ping.json).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    expect(sent).toEqual([]);
  });

  it("refuses a body that is not JSON by its type with 415", async () => {
    const { fetchImpl } = fakeCloud();
    const { base } = await listening({ fetchImpl });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonx"]) {
      const out = await post(`${base}/mcp/shop`, initialize("2025-11-25"), {
        authorization: `Bearer ${TOKEN}`,
        "content-type": type,
      });
      expect(out.status, type).toBe(415);
    }
    const charset = await post(`${base}/mcp/shop`, initialize("2025-11-25"), {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    });
    expect(charset.status).toBe(200);
  });

  it("answers a failure of its own as an internal error that names nothing, and logs it without the credential", async () => {
    const { fetchImpl } = fakeCloud();
    const logged: string[] = [];
    const { base } = await listening({
      fetchImpl,
      newKey: () => {
        throw new Error(`boom with ${TOKEN} inside`);
      },
      log: (line) => logged.push(line),
    });
    const out = await post(`${base}/mcp/shop`, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "resolve_error", arguments: { error: "e1" } },
    });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ jsonrpc: "2.0", id: 11, error: { code: -32603, message: "internal error" } });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(TOKEN);
    expect(logged.join("\n")).toContain("boom");
  });
});

describe("the HTTP configuration", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];

  it("listens on the loopback by default, and names no public URL nor origin", () => {
    expect(httpConfigFrom(env({}))).toEqual({ host: "127.0.0.1", port: 8787, publicUrl: "", origins: [] });
  });

  it("reads the host, the port, the public URL and the origins once, as origins", () => {
    expect(
      httpConfigFrom(
        env({
          DOWNTRACE_MCP_HOST: "0.0.0.0",
          DOWNTRACE_MCP_PORT: "0",
          DOWNTRACE_MCP_PUBLIC_URL: "https://Downtrace.Example/",
          DOWNTRACE_MCP_ORIGINS: " https://app.example , http://localhost:3000 ",
        }),
      ),
    ).toEqual({
      host: "0.0.0.0",
      port: 0,
      publicUrl: "https://downtrace.example",
      origins: ["https://app.example", "http://localhost:3000"],
    });
  });

  it("refuses a port, a public URL or an origin that is not one, and a host off the loopback with no public URL", () => {
    for (const vars of [
      { DOWNTRACE_MCP_PORT: "http" },
      { DOWNTRACE_MCP_PORT: "65536" },
      { DOWNTRACE_MCP_PORT: "-1" },
      { DOWNTRACE_MCP_PUBLIC_URL: "downtrace.example" },
      { DOWNTRACE_MCP_PUBLIC_URL: "ftp://downtrace.example" },
      { DOWNTRACE_MCP_PUBLIC_URL: "https://downtrace.example/mcp" },
      { DOWNTRACE_MCP_PUBLIC_URL: "https://user@downtrace.example" },
      { DOWNTRACE_MCP_PUBLIC_URL: "https://downtrace.example/?a=1" },
      { DOWNTRACE_MCP_ORIGINS: "https://app.example/path" },
      { DOWNTRACE_MCP_HOST: "0.0.0.0" },
    ]) {
      expect(() => httpConfigFrom(env(vars)), JSON.stringify(vars)).toThrow(ConfigError);
    }
  });
});

describe("downtrace-mcp --http", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function started(args: string[], vars: Record<string, string>) {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...vars },
      stdio: ["pipe", "pipe", "pipe"],
    });
    open.push({ close: () => child.kill() });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, stderr: () => stderr, exited };
  }

  it("serves HTTP on the configured port, and says where on stderr without any credential", async () => {
    const { stderr, exited } = started(["--http"], {
      DOWNTRACE_URL: CLOUD,
      DOWNTRACE_TOKEN: "dtr_must_not_be_used",
      DOWNTRACE_MCP_PORT: "0",
    });
    let address: string | undefined;
    for (let i = 0; i < 100 && address === undefined; i++) {
      address = /(http:\/\/127\.0\.0\.1:\d+)\/mcp\/<project>/.exec(stderr())?.[1];
      if (address === undefined) await new Promise((r) => setTimeout(r, 50));
    }
    expect(address, stderr()).toBeDefined();
    // DOWNTRACE_TOKEN is not a credential over HTTP: a request with none is still answered 401.
    const out = await post(`${address}/mcp/shop`, initialize("2025-11-25"), {});
    expect(out.status).toBe(401);
    const opened = await post(`${address}/mcp/shop`, initialize("2025-11-25"));
    expect(opened.status).toBe(200);
    expect(stderr()).not.toContain("dtr_must_not_be_used");
    expect(stderr()).not.toContain(TOKEN);
    expect(stderr()).toContain("DOWNTRACE_TOKEN");
    const before = await Promise.race([exited, new Promise((r) => setTimeout(() => r("running"), 50))]);
    expect(before).toBe("running");
  });

  it("exits 2 and says why when the HTTP configuration is not usable, or an argument is unknown", async () => {
    const offLoopback = started(["--http"], { DOWNTRACE_URL: CLOUD, DOWNTRACE_MCP_HOST: "0.0.0.0" });
    expect(await offLoopback.exited).toBe(2);
    expect(offLoopback.stderr()).toContain("DOWNTRACE_MCP_PUBLIC_URL");
    const unknown = started(["--htttp"], { DOWNTRACE_URL: CLOUD });
    expect(await unknown.exited).toBe(2);
    expect(unknown.stderr()).toContain("--htttp");
  });
});
