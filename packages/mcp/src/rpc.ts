/**
 * JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout, which is the whole of what MCP's stdio transport
 * is.
 *
 * Written out rather than pulled in. The official SDK is the conventional choice and brings a dependency tree
 * for what is, on a tools-only server, three methods; the two published packages of this repo have zero
 * runtime dependencies and that is worth keeping. The risk is real and named in ADR 0078: the protocol could
 * move under us. What holds it is that the revisions it speaks, `PROTOCOL_VERSIONS`, are a constant list and
 * every message shape has a test in each revision it differs in.
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
 * What answers a message: its result, `undefined` for a method there is not, or a throw for one that failed.
 * The signal is aborted when the client cancels the request, and the work it started should stop.
 */
export type Handler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;

/**
 * What one line carries: the message, or the failure that answers a line that carries none.
 *
 * A line that is not JSON gets a parse error and the server stays up: a coding agent that sends one bad
 * message must not lose the session, and a transport that dies on malformed input is one more thing that
 * fails silently at three in the morning.
 */
function read(line: string): Incoming | Failure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail(null, ParseError, "the line is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(null, InvalidRequest, "a JSON-RPC message is an object");
  }
  // The line is external input, so it is `unknown` until checked (repo rule); the cast is at this boundary
  // and nowhere else.
  const message = parsed as Incoming;
  if (typeof message.method !== "string") {
    return fail(message.id ?? null, InvalidRequest, "a JSON-RPC message needs a method");
  }
  return message;
}

/** Says what to answer a message with, or nothing when it was a notification. */
async function answer(message: Incoming, handle: Handler, signal: AbortSignal): Promise<Outgoing | undefined> {
  // A notification has no id and must not be answered, however it went.
  const id = message.id;
  try {
    const result = await handle(message.method, message.params, signal);
    if (id === undefined) return undefined;
    if (result === undefined) return fail(id, MethodNotFound, `unknown method ${message.method}`);
    return ok(id, result);
  } catch (err) {
    if (id === undefined) return undefined;
    return fail(id, InternalError, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The request a `notifications/cancelled` names, when it names one a request could have been sent with.
 * Anything else names nothing: the protocol asks a receiver to ignore a malformed cancellation, and from
 * 2025-11-25 one may name no request at all, because it is how a task would be cancelled, and this server has
 * no tasks.
 */
function cancelled(params: unknown): string | number | undefined {
  if (typeof params !== "object" || params === null || !("requestId" in params)) return undefined;
  const id = params.requestId;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/**
 * Splits a stream into lines and answers each one, each as soon as its own work is done.
 *
 * Not one after another: a call can wait for the cloud up to its timeout, and a `ping` or a cancellation
 * read behind it would wait as long (DT-39). Every message starts as it is read, in the order it came, and
 * its answer is written when it is ready — out of order, which JSON-RPC allows, since an answer carries the
 * id of its request. How many are in flight is the client's to decide: each one is a request it sent.
 *
 * A cancellation is handled here, because this is where the requests in flight are known by their id. It
 * aborts the signal of the one it names and that request gets no answer, as MCP asks of a cancelled request
 * — not even one whose work finished before its answer was written, which the protocol would allow: a
 * cancelled request is never answered, and that is the whole rule. One that names a request not in flight
 * does nothing.
 *
 * Each answer is one `write` of one whole line, so two answers ready at once never share or split a line. A
 * `write` that throws is not caught: there is nowhere left to answer, and it is the process's own failure,
 * as it was when this loop waited for each answer.
 *
 * When the input ends, what is still in flight is answered before this returns: a client closes the input
 * to shut the server down and waits for it to exit, and what it asked before closing is still answered. The
 * timeout of each call bounds the wait.
 *
 * Kept apart from the reading of stdin so a test can drive it with any iterable, which is the only way to
 * check the framing and the order of the answers without a child process.
 */
export async function serve(
  lines: AsyncIterable<string> | Iterable<string>,
  handle: Handler,
  write: (line: string) => void,
): Promise<void> {
  const inFlight = new Map<string | number, AbortController>();
  const answering = new Set<Promise<void>>();
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const message = read(trimmed);
    if (!("method" in message)) {
      write(`${JSON.stringify(message)}\n`);
      continue;
    }
    const id = message.id;
    if (message.method === "notifications/cancelled" && id === undefined) {
      const named = cancelled(message.params);
      if (named !== undefined) inFlight.get(named)?.abort();
      continue;
    }
    const controller = new AbortController();
    // A client must not reuse an id while its request is in flight. One that does has its cancellation reach
    // the latest, and the earlier one finishing does not take the latest's entry with it.
    if (id !== undefined) inFlight.set(id, controller);
    const answered: Promise<void> = answer(message, handle, controller.signal).then((out) => {
      answering.delete(answered);
      if (id !== undefined && inFlight.get(id) === controller) inFlight.delete(id);
      if (out !== undefined && !controller.signal.aborted) write(`${JSON.stringify(out)}\n`);
    });
    answering.add(answered);
  }
  await Promise.all(answering);
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
