import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { answer, type Failure, fail, type Incoming, InternalError, InvalidRequest, ParseError } from "./rpc.ts";
import { createServer, PROTOCOL_VERSIONS, type ProtocolVersion } from "./server.ts";

/**
 * The stdio server over MCP's Streamable HTTP transport, with the credential each request carries as its Bearer token
 * in place of `DOWNTRACE_TOKEN` (RF-513, ADR 0263).
 *
 * Stateless: each POST is one JSON-RPC message, and builds a session of its own from its own headers —
 * `Authorization` and `MCP-Protocol-Version`—, so one request's credential is never another's, and a revoked one is
 * refused by the cloud on the next call. A server of tools alone sends nothing unasked, so there is no stream to open:
 * a GET is a 405, and every request is answered with one JSON body.
 *
 * Without a credential it answers 401 naming its Protected Resource Metadata (RFC 9728), whose authorization server is
 * the cloud: that is where an MCP client starts the OAuth that gets it one. `node:http` and nothing else (ADR 0078).
 */

export interface HttpServerOptions {
  /** The cloud: where every call goes, and the authorization server the metadata names. */
  url: string;
  /** The origin clients reach this server at, or empty to take it from a loopback `Host` (`config.ts`). */
  publicUrl: string;
  /** The origins a browser's `Origin` may be besides the server's own. */
  origins: string[];
  version: string;
  /** Injected so a test can answer without a cloud, as the stdio server's are. */
  fetchImpl?: typeof fetch;
  newKey?: () => string;
  timeoutMs?: number;
  /** The largest body a POST may carry. A message of this server's is a few kilobytes. */
  maxBodyBytes?: number;
  /** How long a request, its headers and its body, may take to arrive. */
  readTimeoutMs?: number;
  /** Where a failure of this server's own is said. Never with a credential in it. */
  log?: (line: string) => void;
}

/** A project's slug, as the cloud shapes one. */
const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const MCP_PATH = new RegExp(`^/mcp/(${SLUG})$`);
const METADATA_PATH = new RegExp(`^/\\.well-known/oauth-protected-resource/mcp/(${SLUG})$`);
/** RFC 6750's `b64token`, after the scheme. */
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i;
/** The names a request to a server on the loopback can come with: any other is a name somebody rebound to it. */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
/**
 * The revision a request with no `MCP-Protocol-Version` is answered in: the transport has a server assume
 * `2025-03-26`, which this server answers, as its `initialize` does, with the newest one it speaks that is not later.
 */
const UNNAMED_REVISION: ProtocolVersion = PROTOCOL_VERSIONS.find((v) => v <= "2025-03-26") ?? PROTOCOL_VERSIONS[0];

export function createHttpServer(opts: HttpServerOptions): Server {
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const readTimeoutMs = opts.readTimeoutMs ?? 10_000;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = createHttp({
    // Node answers 408 and closes when a request has not arrived whole by then; the check runs at this interval.
    requestTimeout: readTimeoutMs,
    headersTimeout: readTimeoutMs,
    connectionsCheckingInterval: Math.min(1000, readTimeoutMs),
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      // Nothing above throws by design; if something does, the client gets no detail of it, and the line logged
      // carries no credential.
      log(`downtrace-mcp: failed to answer a request: ${redacted(messageOf(err), req)}`);
      if (!res.headersSent) refuse(res, 500, InternalError, "internal error");
      else res.destroy();
    });
  });
  return server;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    const own = ownOrigin(req);
    if (own === undefined) {
      return refuse(res, 403, InvalidRequest, "this server is not reached by that name");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigin(origin, own)) {
      return refuse(res, 403, InvalidRequest, "this server does not answer requests from that origin");
    }
    const target = new URL(req.url ?? "/", "http://request.invalid");
    const metadata = METADATA_PATH.exec(target.pathname);
    if (metadata !== null) {
      if (req.method !== "GET") return refuse(res, 405, InvalidRequest, "the metadata is read with GET", "GET");
      return send(res, 200, {
        resource: `${own}/mcp/${metadata[1]}${target.search}`,
        authorization_servers: [opts.url],
        bearer_methods_supported: ["header"],
      });
    }
    const mcp = MCP_PATH.exec(target.pathname);
    if (mcp === null) return refuse(res, 404, InvalidRequest, "this server serves /mcp/<project>");
    const project = mcp[1] ?? "";
    if (req.method !== "POST") {
      return refuse(res, 405, InvalidRequest, "each message is a POST: this server opens no stream", "POST");
    }

    const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      const where = `${own}/.well-known/oauth-protected-resource/mcp/${project}${target.search}`;
      res.setHeader("www-authenticate", `Bearer resource_metadata="${where.replace(/[\\"]/g, "\\$&")}"`);
      return refuse(
        res,
        401,
        InvalidRequest,
        "this server needs an access credential of the project as a Bearer token",
      );
    }
    const named = req.headers["mcp-protocol-version"];
    let revision = UNNAMED_REVISION;
    if (named !== undefined) {
      const spoken = PROTOCOL_VERSIONS.find((v) => v === named);
      if (spoken === undefined) {
        return refuse(
          res,
          400,
          InvalidRequest,
          `MCP-Protocol-Version: this server speaks ${PROTOCOL_VERSIONS.join(", ")}`,
        );
      }
      revision = spoken;
    }
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return refuse(res, 415, InvalidRequest, "a message is application/json");

    const body = await bodyOf(req, maxBodyBytes);
    // A client that left before its message arrived is answered nothing: there is nobody to answer.
    if (body === "closed") return;
    if (body === "too-large") return refuse(res, 413, InvalidRequest, `a message is at most ${maxBodyBytes} bytes`);
    const message = messageIn(body.text);
    if ("error" in message) return send(res, 400, message);

    const session = createServer({
      config: { url: opts.url, token },
      version: opts.version,
      project,
      revision,
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.newKey === undefined ? {} : { newKey: opts.newKey }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });
    // A client that goes away cancels its request: the call to the cloud is aborted, and nothing is written.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const out = await answer(
      message,
      async (method, params, signal) => {
        try {
          return await session.handle(method, params, signal);
        } catch (err) {
          // The method is the client's text: quoted, so it cannot write a line of its own into the log.
          log(`downtrace-mcp: failed to answer ${JSON.stringify(method)}: ${redacted(messageOf(err), req)}`);
          throw new Error("internal error");
        }
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (out === undefined) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, out);
  }

  /**
   * The origin this request reached the server at: the public URL, or, without one, the request's `Host` when it is a
   * loopback name. `undefined` for any other `Host`, which on the loopback is a name rebound to it (DNS rebinding).
   */
  function ownOrigin(req: IncomingMessage): string | undefined {
    if (opts.publicUrl !== "") return opts.publicUrl;
    const host = req.headers.host ?? "";
    return LOOPBACK_HOST.test(host) ? originOrUndefined(`http://${host}`) : undefined;
  }

  /** A browser's `Origin`, accepted when it is the server's own or one configured. */
  function allowedOrigin(origin: string, own: string): boolean {
    const o = originOrUndefined(origin);
    return o !== undefined && (o === originOrUndefined(own) || opts.origins.includes(o));
  }
}

/**
 * The body; or `too-large` when it is larger than `max`, declared or as it arrives; or `closed` when the client left
 * before it arrived. What comes after the limit is read and dropped rather than left unread, so the answer reaches
 * the client before the connection closes; how long that may take is bounded by the read timeout.
 */
function bodyOf(req: IncomingMessage, max: number): Promise<{ text: string } | "too-large" | "closed"> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > max) {
      req.resume();
      resolve("too-large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        settled = true;
        chunks.length = 0;
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("close", () => {
      if (settled) return;
      settled = true;
      resolve("closed");
    });
  });
}

/**
 * One JSON-RPC message, or the failure that answers a body that is not one. It says what is wrong and nothing of the
 * parser's. A batch is not one: the revisions this server speaks over HTTP take a message per POST.
 */
function messageIn(body: string): Incoming | Failure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail(null, ParseError, "the body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(null, InvalidRequest, "a message is one JSON-RPC object, and this server takes no batches");
  }
  const { method, id, params } = parsed as Record<string, unknown>;
  if (typeof method !== "string") return fail(null, InvalidRequest, "a JSON-RPC message needs a method");
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    return fail(null, InvalidRequest, "a JSON-RPC id is a string or a number");
  }
  return { jsonrpc: "2.0", method, ...(id === undefined ? {} : { id }), ...(params === undefined ? {} : { params }) };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** An answer that is not the message's: its status, and, as the transport allows, a JSON-RPC error with no id. */
function refuse(res: ServerResponse, status: number, code: number, message: string, allow?: string): void {
  if (allow !== undefined) res.setHeader("allow", allow);
  send(res, status, fail(null, code, message));
}

function originOrUndefined(value: string): string | undefined {
  try {
    const o = new URL(value).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A line about a request, with its credential, if it carries one, taken out. */
function redacted(line: string, req: IncomingMessage): string {
  const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
  return token === undefined ? line : line.split(token).join("[credential]");
}
