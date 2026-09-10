/**
 * JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout, which is the whole of what MCP's stdio transport
 * is.
 *
 * Written out rather than pulled in. The official SDK is the conventional choice and brings a dependency tree
 * for what is, on a tools-only server, three methods; the two published packages of this repo have zero
 * runtime dependencies and that is worth keeping. The risk is real and named in ADR 0078: the protocol could
 * move under us. What holds it is that `PROTOCOL_VERSION` is a constant and every message shape has a test.
 */

/** A request or a notification arriving from the client. */
export interface Incoming {
  jsonrpc: "2.0";
  /** Absent on a notification, which is a message that must not be answered. */
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface Success {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface Failure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type Outgoing = Success | Failure;

/** The codes JSON-RPC 2.0 reserves. Nothing here invents its own. */
export const ParseError = -32700;
export const InvalidRequest = -32600;
export const MethodNotFound = -32601;
export const InternalError = -32603;

export function ok(id: string | number, result: unknown): Success {
  return { jsonrpc: "2.0", id, result };
}

export function fail(id: string | number | null, code: number, message: string): Failure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Reads one line and says what to answer, or nothing when the message was a notification.
 *
 * A line that is not JSON gets a parse error and the server stays up: a coding agent that sends one bad
 * message must not lose the session, and a transport that dies on malformed input is one more thing that
 * fails silently at three in the morning.
 */
export async function respondTo(
  line: string,
  handle: (method: string, params: unknown) => Promise<unknown>,
): Promise<Outgoing | undefined> {
  let message: Incoming;
  try {
    // The line is external input, so it is `unknown` until checked (repo rule); the cast is at this
    // boundary and nowhere else.
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fail(null, InvalidRequest, "a JSON-RPC message is an object");
    }
    message = parsed as Incoming;
  } catch {
    return fail(null, ParseError, "the line is not JSON");
  }
  if (typeof message.method !== "string") {
    return fail(message.id ?? null, InvalidRequest, "a JSON-RPC message needs a method");
  }
  // A notification has no id and must not be answered, however it went.
  const id = message.id;
  try {
    const result = await handle(message.method, message.params);
    if (id === undefined) return undefined;
    if (result === undefined) return fail(id, MethodNotFound, `unknown method ${message.method}`);
    return ok(id, result);
  } catch (err) {
    if (id === undefined) return undefined;
    return fail(id, InternalError, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Splits a stream into lines and answers each one.
 *
 * Kept apart from the reading of stdin so a test can drive it with any iterable, which is the only way to
 * check the framing without a child process.
 */
export async function serve(
  lines: AsyncIterable<string>,
  handle: (method: string, params: unknown) => Promise<unknown>,
  write: (line: string) => void,
): Promise<void> {
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const answer = await respondTo(trimmed, handle);
    if (answer) write(`${JSON.stringify(answer)}\n`);
  }
}

/** Turns a byte stream into the lines JSON-RPC frames its messages with. */
export async function* linesOf(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      yield buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") yield buffer;
}
