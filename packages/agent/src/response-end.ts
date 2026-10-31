import http from "node:http";

/** What is told a response is being ended, before its last bytes are handed to the socket. */
type Listener = (response: http.ServerResponse) => void;

const listeners = new Set<Listener>();
let original: ((...args: unknown[]) => unknown) | undefined;

/**
 * Calls `listener` each time a server response is ended, before `end` hands its last bytes to the socket (ADR 0248).
 * Node publishes a response on its `http.server.response.finish` channel only after those bytes are on the socket,
 * and a client — a test runner that ends the server with SIGKILL as soon as the answer is in — can read them and kill
 * the process before that. One wrapper on `ServerResponse.prototype.end` for every listener, put on with the first and
 * taken off with the last. A listener that throws is the listener's own failure: the response is ended all the same.
 * Returns what stops it.
 */
export function onResponseEnd(listener: Listener): () => void {
  listeners.add(listener);
  if (original === undefined) {
    const end = http.ServerResponse.prototype.end as unknown as (...args: unknown[]) => unknown;
    original = end;
    http.ServerResponse.prototype.end = function (this: http.ServerResponse, ...args: unknown[]) {
      for (const each of listeners) {
        try {
          each(this);
        } catch {
          // A listener guards itself (the agent's `guard`); this one is for one that does not, and never the response's.
        }
      }
      return end.apply(this, args);
    } as typeof http.ServerResponse.prototype.end;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && original !== undefined) {
      http.ServerResponse.prototype.end = original as typeof http.ServerResponse.prototype.end;
      original = undefined;
    }
  };
}
