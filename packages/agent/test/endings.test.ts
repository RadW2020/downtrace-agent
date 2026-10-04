import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * What survives the death of the process, asked of real processes (gh-598, DT-6, ERR-04).
 *
 * `product.md:376` says it in the shape of a commitment: «for each way a process ends —an orderly shutdown, an
 * explicit exit, an exception that kills it— the product states what Downtrace keeps and what it loses». The
 * statement is the table in this package's README, and every row of it is asked of a process that really ends:
 * the orderly endings here, `process.exit()` with and without waiting in `shutdown.test.ts`, and invariant 2 —
 * the process ends exactly as it would have— in `uncaught.test.ts`. A process that does not end cannot prove any
 * of this from the inside.
 *
 *  - **A signal delivers.** SIGTERM reaches the instrumentation's handler, everything it was holding goes out in
 *    one last batch, and the process still dies of that signal (ADR 0095, ADR 0100, invariant 2).
 *  - **An exception that kills does not, and that is decided.** What had already left is on the cloud; the
 *    exception that killed the process is not, and neither is the interval in hand. The flush is asynchronous,
 *    an uncaught exception does not go through `beforeExit`, and a synchronous channel would mean handling it,
 *    which changes how the process ends (ADR 0103). Spooling it to disk to deliver at the next start was weighed
 *    and refused (DT-6): a container's disk is usually ephemeral and the next start may be another instance, and
 *    a write on the death path is synchronous I/O with a bound of its own to keep (invariants 2 and 4). So the
 *    loss is said, and this is the test that pins it, so that nobody later reads its absence as a bug and
 *    "fixes" it into invariant 2.
 *
 * The profile's window is the one line of the contract that is not here: closing it whatever the clock says
 * needs fingerprints, which need `pg`, and `profile.test.ts` («closes the window whatever the clock says») and
 * the end-to-end walk already ask it where the cost is worth paying.
 *
 * And since the gh-617 the batch says **how** the process is leaving, which is what these same processes now
 * also pin: `ending: "signal"` in the last batch of a process that dies of the signal, `ending: "idle"` in the
 * one of a loop that emptied, and **no** ending in any batch of a process an exception killed — the process
 * that cannot say is the one the field exists to tell apart from the one that did (ADR 0148, ERR-04).
 */

const agentDir = fileURLToPath(new URL("..", import.meta.url));

interface Batch {
  intervals?: Array<{ endpoints?: Array<{ route: string; count: number }>; runtime?: unknown }>;
  exceptions?: Array<{ kind: string; count: number; text?: string }>;
  ending?: string;
}

/** Collects the batches that really arrive, so a process can be asked what left it before it died. */
async function sink(): Promise<{ url: string; batches: Batch[]; close: () => Promise<void> }> {
  const batches: Batch[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      try {
        batches.push(JSON.parse(body) as Batch);
      } catch {
        // Not a batch; nothing to record.
      }
      res.writeHead(202, { "content-type": "application/json" }).end('{"accepted":1,"inserted":1}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** One request, recorded the way the instrumentation sees one. */
const ONE_REQUEST = `
  import { channel } from "node:diagnostics_channel";
  const request = { method: "GET", url: "/orders" };
  channel("http.server.request.start").publish({ request });
  channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
`;

interface Ending {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Waits for a line the child prints to say it is ready, and **gives up out loud**.
 *
 * Without a bound of its own this wait is the runner's timeout instead: a child that dies at start-up —a
 * `--import` that throws, a port that is not there— would hang until vitest killed the file, and the failure
 * would name the test rather than what did not arrive.
 */
function said(child: ChildProcess, word: string, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`the child never said "${word}" in ${ms} ms; it printed: ${out || "nothing"}`)),
      ms,
    );
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes(word)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the child ended (${code}/${signal}) before saying "${word}"; it printed: ${out}`));
    });
  });
}

/** Runs a real process with the instrumentation loaded the way a user loads it. */
function run(script: string, url: string, env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    ["--import", `${agentDir}src/register.ts`, "--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        DOWNTRACE_URL: url,
        DOWNTRACE_TOKEN: "t",
        DOWNTRACE_ENV: "test",
        DOWNTRACE_INSTRUMENT: "none",
        DOWNTRACE_INTERVAL_MS: "60000",
        ...env,
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const ended = new Promise<Ending>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, ended };
}

const routesOf = (b: Batch): string[] => (b.intervals ?? []).flatMap((i) => (i.endpoints ?? []).map((e) => e.route));

describe("a process asked to stop", () => {
  const servers: Array<() => Promise<void>> = [];
  const children: ChildProcess[] = [];
  // A failure must not leave a process behind: these children hold timers of tens of seconds on purpose, and an
  // orphan of one outlives the run that spawned it.
  afterEach(async () => {
    while (children.length) children.pop()?.kill("SIGKILL");
    while (servers.length) await servers.pop()?.();
  });

  // The orderly shutdown, the first of ERR-04's three ways a process ends.
  //
  // covers: ERR-04
  it("hands over what it was holding, and still dies of the signal", async () => {
    // The orderly ending. Everything the instrumentation had in hand goes out in one batch: the interval and
    // the exceptions it had recorded. And the signal is not stolen — invariant 2 is about what the application
    // would have done, and what it would have done is die of SIGTERM.
    const s = await sink();
    servers.push(s.close);
    const script = `
      ${ONE_REQUEST}
      // Recorded and survived, so there is something in hand for the last flush to carry. Its own handler is
      // what keeps the process alive; watching it is ours and changes nothing (ADR 0103).
      process.on("uncaughtException", () => {});
      setTimeout(() => { throw new TypeError("boom in a timer"); }, 5);
      // Long enough for the signal to arrive, and it never fires: the signal is what ends this process.
      setTimeout(() => {}, 30000);
      // Said on stdout so the test sends the signal once there is something to lose.
      setTimeout(() => console.log("ready"), 60);
    `;
    const { child, ended } = run(script, s.url);
    children.push(child);
    await said(child, "ready");
    child.kill("SIGTERM");
    const how = await ended;

    expect(how.signal, `it ended ${how.code}/${how.signal}`).toBe("SIGTERM");
    expect(s.batches, "nothing was handed over on the way out").toHaveLength(1);
    const last = s.batches[0];
    expect(routesOf(last as Batch)).toContain("/orders");
    const thrown = last?.exceptions;
    expect(thrown, `the exceptions it had recorded did not travel: ${JSON.stringify(last)}`).toHaveLength(1);
    expect(thrown?.[0]?.kind).toBe("uncaught");
    expect(thrown?.[0]?.text).toContain("TypeError");
    // The last batch says how the process is leaving: the signal reached the instrumentation's own handler,
    // and it is the one that says so (gh-617, ADR 0148).
    expect(last?.ending, `the last batch does not say how it left: ${JSON.stringify(last)}`).toBe("signal");
  }, 30_000);

  it("an emptied loop says idle in its last batch", async () => {
    // The third ending: nothing asked the process to leave, it ran out of work. The only thing that sends the
    // last batch is the loop emptying, and the batch that goes out says so rather than being read as a stop.
    const s = await sink();
    servers.push(s.close);
    const script = `
      ${ONE_REQUEST}
      // Nothing else keeps the loop alive: no timer, no server, no work. The process leaves on its own.
    `;
    const { ended } = run(script, s.url);
    const how = await ended;

    expect(how.code, `it ended ${how.code}/${how.signal}`).toBe(0);
    expect(s.batches, "the emptied loop left no batch").toHaveLength(1);
    expect(routesOf(s.batches[0] as Batch)).toContain("/orders");
    expect(s.batches[0]?.ending, `the last batch does not say how it left: ${JSON.stringify(s.batches[0])}`).toBe(
      "idle",
    );
  }, 30_000);

  it("a signal the application also hears wins when it then shuts down", async () => {
    // The first reason wins (gh-617): the signal's drain is under way when the application's own handler runs
    // and calls `shutdown()`, and the drain that then goes out must not rewrite the ending to `exit`. What the
    // process is leaving for was decided by the signal, and every batch from then on says `signal`.
    const s = await sink();
    servers.push(s.close);
    const script = `
      import { shutdown } from "${agentDir}src/registered.ts";
      ${ONE_REQUEST}
      // What a well-behaved application does: wait for the hand-over, then leave. The process is not dead of
      // the signal — the application heard it and went out on its own terms.
      process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
      // Keeps the process alive until the test sends the signal; it never fires, which is what is under test.
      setTimeout(() => {}, 30000);
      // Said on stdout so the test sends the signal once there is something to lose.
      setTimeout(() => console.log("ready"), 60);
    `;
    const { child, ended } = run(script, s.url);
    children.push(child);
    await said(child, "ready");
    child.kill("SIGTERM");
    const how = await ended;

    // The process is not dead of the signal: the application heard it and kept going, and when its work —and
    // the last flush— were done it left on its own.
    expect(how.code, `it ended ${how.code}/${how.signal}`).toBe(0);
    // The batch that left says the signal, and no batch says anything else: the `shutdown()` the application
    // ran did not rewrite the ending to `exit` (gh-617).
    expect(s.batches, "nothing was handed over on the way out").toHaveLength(1);
    expect(routesOf(s.batches[0] as Batch)).toContain("/orders");
    expect(s.batches[0]?.ending, `the ending is not the signal's: ${JSON.stringify(s.batches[0])}`).toBe("signal");
  }, 30_000);
});

describe("a process an exception kills", () => {
  const servers: Array<() => Promise<void>> = [];
  const children: ChildProcess[] = [];
  // A failure must not leave a process behind: these children hold timers of tens of seconds on purpose, and an
  // orphan of one outlives the run that spawned it.
  afterEach(async () => {
    while (children.length) children.pop()?.kill("SIGKILL");
    while (servers.length) await servers.pop()?.();
  });

  // The exception that kills, the third of ERR-04's three ways a process ends. Every clause of its row in the
  // README is asked here, the half that survives and the half that does not, because the pair is the contract.
  //
  // covers: ERR-04
  it("keeps what had already left, and loses the exception that killed it and the interval in hand", async () => {
    // «What survives a crash is what had already left: the aggregates of the previous intervals and the runtime
    // signals» (`product.md:25`), and the exceptions that rode an earlier batch. The exception that did the
    // killing is not part of it, and neither is what the process was holding when it died.
    const s = await sink();
    servers.push(s.close);
    const script = `
      import { captureException } from "${agentDir}src/index.ts";
      ${ONE_REQUEST}
      // An error the application handled and handed over, early: it rides the first batch, like any exception
      // the process survived.
      captureException(new RangeError("handled before the crash"));
      // The shortest interval the configuration accepts —a second; anything less falls back to the default of
      // ten, which is how the first draft of this test proved nothing— so the request is aggregated and sent
      // twice over before anything goes wrong. Then the throw an application's timer would do, right after a
      // request the next flush would have carried: the interval in hand.
      setTimeout(() => {
        const request = { method: "POST", url: "/checkout" };
        channel("http.server.request.start").publish({ request });
        channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
        throw new TypeError("boom in a timer");
      }, 2600);
    `;
    // The runtime observer on, so the earlier intervals carry the runtime signals the README says survive.
    const { child, ended } = run(script, s.url, { DOWNTRACE_INTERVAL_MS: "1000", DOWNTRACE_INSTRUMENT: "runtime" });
    children.push(child);
    const how = await ended;

    // It died the way it would have died with nothing installed. The full comparison against an uninstrumented
    // process is `uncaught.test.ts`; this is the sanity check that the case under test really happened.
    expect(how.code, `it ended ${how.code}/${how.signal}`).toBe(1);
    expect(how.stderr).toContain("TypeError");

    // What had already left is there: the earlier interval, with the runtime signals of the process beside it,
    // and the exception that rode an earlier batch.
    expect(s.batches.length, "nothing left before the crash: this test would prove nothing").toBeGreaterThan(0);
    const earlier = s.batches
      .flatMap((b) => b.intervals ?? [])
      .find((i) => routesOf({ intervals: [i] }).includes("/orders"));
    expect(earlier, "the interval sent before the crash is not there").toBeDefined();
    expect(earlier?.runtime, `the runtime signals did not travel with it: ${JSON.stringify(earlier)}`).toBeDefined();
    const thrown = s.batches.flatMap((b) => b.exceptions ?? []);
    expect(
      thrown.some((e) => e.kind === "explicit" && e.text?.includes("RangeError")),
      `the exception that rode an earlier batch is not there: ${JSON.stringify(thrown)}`,
    ).toBe(true);

    // And what the process was holding when it died is not, and it is not a race: sending is asynchronous, an
    // uncaught exception does not go through `beforeExit`, and there is no synchronous channel to send it on
    // (ADR 0103). A moment for a late batch, so that a pass here is the contract and not the clock.
    await new Promise((r) => setTimeout(r, 300));
    const killer = s.batches.flatMap((b) => b.exceptions ?? []).filter((e) => e.kind !== "explicit");
    expect(killer, `the exception that killed the process arrived: ${JSON.stringify(killer)}`).toHaveLength(0);
    expect(s.batches.flatMap(routesOf), "the interval in hand arrived with a process that died").not.toContain(
      "/checkout",
    );
    // And no batch says how the process ended, because the process that is killed cannot say: an ending it
    // never declared is the one the cloud reads as «stopped», and that reading is the honest one (ADR 0148).
    const said = s.batches.filter((b) => b.ending !== undefined);
    expect(said, `a batch declared an ending the process cannot have: ${JSON.stringify(said)}`).toHaveLength(0);
  }, 30_000);
});
