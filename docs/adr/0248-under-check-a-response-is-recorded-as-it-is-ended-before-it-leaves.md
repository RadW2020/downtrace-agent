# 0248 — Under `check`, a response is recorded as it is ended, before it leaves the process

Estado: aceptado · Fecha: 2026-10-31 · Alcance: público

## Context

Under `downtrace check`, a process writes what it holds each time it has no request in flight, so that a runner that
ends the application's server with SIGKILL as soon as the last answer is in — Playwright's `webServer` does — does not
take that answer's request with it. The write ran where the request was recorded, at Node's
`http.server.response.finish`. Node publishes it once the response's last bytes are on the socket, in a later tick: the
client can read them and kill the server first. The test that ends a server that way lost a request one run in four,
and once the check reads a request less on one side, it says something false.

There was a second way to lose one. An interval and a profile window are written with their start rounded down to the
millisecond, and `check` counts one written twice — by a write and by the exit — once, by that start. Two closed within
one millisecond, as two answers of an in-memory database can be, were one to it.

## Decision

**Under `check`, and when the process only writes locally, a response is recorded as `ServerResponse.prototype.end`
is called, before it hands its last bytes to the socket, and its `finish` is not recorded again. An interval or a window
starts at the earliest in the millisecond after the one the last started in.**

- One wrapper on `end`, for every listener, put on with the first and taken off with the last; outside `check` nothing
  wraps it, and production records at `finish` as it did.
- A request is recorded once: at `end` if it was seen to start, and its `finish` is then skipped. A response that
  never finishes — its client went away — is recorded at `end` under `check`, where it was not before.
- The duration ends at `end` instead of `finish`: under `check` durations are shown and never judged.

## Alternatives

- **Keep `finish`, and tell runners to wait.** Playwright's default is SIGKILL, and the user does not choose it.
- **The response's `prefinish`.** Node emits it after the bytes are written, in the same call to `end`: the write that
  follows takes milliseconds, and the kill lands inside it.
- **Read the windows by their start and their content.** Two answers of the same route, a millisecond apart, write the
  same content: indistinguishable from a write repeated by the exit.

## Consequences

- The test that ends a server with SIGKILL as soon as its last answer is in passes ten runs in ten; a test checks that
  the request is written by the time `end` returns.
- An interval or a window can start up to a millisecond after it was closed, which no reading of them can tell.
