import { REGRESSIONS, type Regression } from "@downtrace/reference-app";
import { describe, expect, it } from "vitest";
import { type CanaryConfig, runCycle } from "../src/canary.ts";
import type { FindingSummary } from "../src/canary-expectations.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-10-02T01:00:00Z");

const config: CanaryConfig = {
  appUrl: "http://app:4000",
  cloudUrl: "https://cloud.test",
  project: "canary",
  token: "dt_read",
  appToken: "",
  pollMs: MINUTE,
  detectWithinMs: 45 * MINUTE,
  recoverWithinMs: 60 * MINUTE,
  requestTimeoutMs: 20_000,
  freshWithinMs: 2 * MINUTE,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
  hasSignal: boolean;
}

type Patch = Record<string, { enabled?: boolean; params?: Record<string, number> }>;

/**
 * A reference app and a cloud in memory, and a clock that moves only when the canary sleeps. Each scenario says
 * what the cloud answers as a function of the time and of when the regression was switched on and off.
 */
function world(
  scenario: {
    appDown?: boolean;
    appToken?: string;
    putFails?: (patch: Patch, index: number) => boolean;
    initiallyOn?: Regression[];
    cloudDown?: (now: number) => boolean;
    lastReceivedAgoMs?: (now: number) => number;
    findings?: (now: number, on: number | null) => FindingSummary[];
    pattern?: string | null;
    verification?: (now: number, off: number) => { conclusion: string; because?: string; waitingCouldHelp: boolean };
    sleepThrowsAt?: number;
  } = {},
) {
  let now = START;
  let onAt: number | null = null;
  let offAt: number | null = null;
  let puts = 0;
  const state = Object.fromEntries(
    REGRESSIONS.map((r) => [
      r,
      {
        enabled: scenario.initiallyOn?.includes(r) ?? false,
        params: r === "slow_dependency" ? { delayMs: 3000 } : ({} as Record<string, number>),
      },
    ]),
  ) as Record<Regression, { enabled: boolean; params: Record<string, number> }>;
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    calls.push({ method, url, body, authorization: headers.get("authorization"), hasSignal: init.signal != null });
    if (url.startsWith(config.appUrl)) {
      if (scenario.appDown) throw new TypeError("fetch failed");
      if (scenario.appToken !== undefined && headers.get("authorization") !== `Bearer ${scenario.appToken}`) {
        return json({ error: "unauthorized" }, 401);
      }
      if (method === "PUT") {
        const index = puts++;
        if (scenario.putFails?.(body as Patch, index)) return json({ error: "boom" }, 500);
        for (const [name, patch] of Object.entries(body as Patch)) {
          const s = state[name as Regression];
          if (patch.enabled !== undefined) s.enabled = patch.enabled;
          if (patch.params) s.params = { ...s.params, ...patch.params };
          if (patch.enabled === true) onAt = now;
          else if (patch.enabled === false && onAt !== null) offAt = now;
        }
      }
      return json(state);
    }
    if (scenario.cloudDown?.(now)) throw new TypeError("fetch failed");
    const path = url.slice(config.cloudUrl.length);
    if (path === "/api/p/canary/status") {
      const ago = scenario.lastReceivedAgoMs?.(now) ?? 10_000;
      return json({ freshness: { lastReceivedAt: new Date(now - ago).toISOString() } });
    }
    if (path === "/api/p/canary/findings") {
      return json({ findings: scenario.findings?.(now, onAt) ?? [] });
    }
    if (/^\/api\/p\/canary\/findings\/\d+\/report$/.test(path)) {
      return json({ version: "r1", pattern: scenario.pattern === null ? null : { name: scenario.pattern } });
    }
    if (/^\/api\/p\/canary\/findings\/\d+\/verification\?since=/.test(path)) {
      return json(scenario.verification?.(now, offAt ?? now) ?? { conclusion: "inconclusive", waitingCouldHelp: true });
    }
    return json({ error: `no route ${path}` }, 404);
  };

  return {
    deps: {
      fetch,
      now: () => new Date(now),
      sleep: async (ms: number) => {
        if (scenario.sleepThrowsAt !== undefined && now >= scenario.sleepThrowsAt) throw new Error("the clock broke");
        now += ms;
      },
    },
    state,
    calls,
    puts: () => calls.filter((c) => c.method === "PUT").map((c) => c.body),
  };
}

/** A finding as the cloud gives one for a route: with its endpoint and the dependency it is about. */
const checkout = (since: number, overrides: Partial<FindingSummary> = {}): FindingSummary => ({
  id: 41,
  state: "open",
  trigger: "composition_shift",
  scope: "route",
  endpoint: { method: "POST", route: "/checkout" },
  dependency: { kind: "postgres", target: "postgres:5432" },
  since: new Date(since).toISOString(),
  ...overrides,
});

/** Opens the expected finding ten minutes after the regression goes on. */
const opensAfterTen = (now: number, on: number | null) =>
  on !== null && now >= on + 10 * MINUTE ? [checkout(on + 8 * MINUTE)] : [];

/** Recovery is observed fifteen minutes after the regression goes off. */
const recoversAfterFifteen = (now: number, off: number) =>
  now >= off + 15 * MINUTE
    ? { conclusion: "recovery-observed", waitingCouldHelp: false }
    : { conclusion: "degradation-persists", waitingCouldHelp: true };

const passing = { findings: opensAfterTen, pattern: "operation-multiplication", verification: recoversAfterFifteen };

describe("runCycle", () => {
  it("passes when the expected finding opens, the report names the pattern and the recovery is observed", async () => {
    const w = world(passing);
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("pass");
    expect(result.finding?.id).toBe(41);
    expect(result.finding?.pattern).toBe("operation-multiplication");
    expect(result.minutesToDetect).toBe(10);
    expect(result.minutesToRecover).toBe(15);
    expect(result.switchedOff).toBe(true);
    expect(w.state.n_plus_one.enabled).toBe(false);
    expect(w.puts()).toEqual([{ n_plus_one: { enabled: true } }, { n_plus_one: { enabled: false, params: {} } }]);
  });

  it("switches on what a regression needs to show, and gives back the parameters it found", async () => {
    const w = world({
      findings: (now, on) =>
        on !== null && now >= on + 10 * MINUTE ? [checkout(on, { trigger: "dependency_degraded" })] : [],
      pattern: "dependency-degradation",
      verification: recoversAfterFifteen,
    });
    const result = await runCycle("aggressive_retries", config, w.deps);

    expect(result.outcome).toBe("pass");
    expect(w.puts()[0]).toEqual({
      aggressive_retries: { enabled: true },
      slow_dependency: { enabled: true, params: { delayMs: 1000 } },
    });
    expect(w.state.slow_dependency).toEqual({ enabled: false, params: { delayMs: 3000 } });
    expect(w.state.aggressive_retries.enabled).toBe(false);
  });

  it("asks the cloud with the credential and gives every request a timeout", async () => {
    const w = world(passing);
    await runCycle("n_plus_one", config, w.deps);

    const cloudCalls = w.calls.filter((c) => c.url.startsWith(config.cloudUrl));
    expect(cloudCalls.length).toBeGreaterThan(0);
    for (const c of cloudCalls) expect(c.authorization).toBe("Bearer dt_read");
    for (const c of w.calls) expect(c.hasSignal, c.url).toBe(true);
  });

  it("gives the reference app its own token, and the cloud its own", async () => {
    const w = world({ ...passing, appToken: "app-secret" });
    const result = await runCycle("n_plus_one", { ...config, appToken: "app-secret" }, w.deps);

    expect(result.outcome).toBe("pass");
    for (const c of w.calls.filter((c) => c.url.startsWith(config.appUrl))) {
      expect(c.authorization).toBe("Bearer app-secret");
    }
    for (const c of w.calls.filter((c) => c.url.startsWith(config.cloudUrl)))
      expect(c.authorization).toBe("Bearer dt_read");
  });

  it("is unmeasurable, and switches nothing on, when the reference app refuses the canary's token", async () => {
    const w = world({ appToken: "app-secret" });
    const result = await runCycle("n_plus_one", { ...config, appToken: "wrong" }, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/401/);
    expect(result.enabledAt).toBeNull();
  });

  it("fails when no expected finding opens in time, saying what opened instead, and switches the regression off", async () => {
    const other = (now: number, on: number | null) =>
      on !== null && now >= on + 5 * MINUTE ? [checkout(on + 4 * MINUTE, { id: 9, trigger: "latency_shift" })] : [];
    const w = world({ findings: other });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/45 min/);
    expect(result.openedInstead.map((f) => f.id)).toEqual([9]);
    expect(w.state.n_plus_one.enabled).toBe(false);
    expect(result.switchedOff).toBe(true);
  });

  it("does not take a finding that was already open before the regression went on", async () => {
    const w = world({ findings: () => [checkout(START - 30 * MINUTE)] });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/already open/);
    expect(w.puts()).toEqual([]);
  });

  it("fails when the report recognises another pattern, and says both", async () => {
    const w = world({ ...passing, pattern: "load-change" });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/load-change/);
    expect(result.reason).toMatch(/operation-multiplication/);
    expect(w.state.n_plus_one.enabled).toBe(false);
  });

  it("fails when the degradation persists after the regression is off", async () => {
    const w = world({
      ...passing,
      verification: () => ({ conclusion: "degradation-persists", waitingCouldHelp: true }),
    });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/degradation-persists/);
    expect(result.lastVerification?.conclusion).toBe("degradation-persists");
  });

  it("fails without waiting when the verification is inconclusive and waiting could not help", async () => {
    const w = world({
      ...passing,
      verification: () => ({
        conclusion: "inconclusive",
        because: "the reference was not kept",
        waitingCouldHelp: false,
      }),
    });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/the reference was not kept/);
    expect(result.minutesToRecover).toBeNull();
  });

  it("is unmeasurable, and switches nothing on, when the reference app does not answer", async () => {
    const w = world({ appDown: true });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/reference app/);
    expect(result.enabledAt).toBeNull();
  });

  it("is unmeasurable, and switches nothing on, when the cloud does not answer", async () => {
    const w = world({ cloudDown: () => true });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/cloud/);
    expect(w.puts()).toEqual([]);
  });

  it("is unmeasurable when nothing of the project has arrived lately: no data is not no errors", async () => {
    const w = world({ lastReceivedAgoMs: () => 10 * MINUTE });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/arrived/);
    expect(w.puts()).toEqual([]);
  });

  it("switches off a regression it finds on, and does not measure over a reference that saw it", async () => {
    const w = world({ initiallyOn: ["pool_leak"] });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/pool_leak/);
    expect(w.state.pool_leak.enabled).toBe(false);
    expect(w.puts()).toEqual([{ pool_leak: { enabled: false } }]);
  });

  it("is unmeasurable, not a failure of the detector, when the cloud stops answering while it waits", async () => {
    const w = world({ cloudDown: (now) => now > START + 2 * MINUTE });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/cloud/);
    expect(w.state.n_plus_one.enabled).toBe(false);
    expect(result.switchedOff).toBe(true);
  });

  it("is unmeasurable when the cloud was silent for most of the window, even if it answers at the end", async () => {
    const w = world({ cloudDown: (now) => now > START + MINUTE && now < START + 44.5 * MINUTE });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/did not answer/);
  });

  it("is unmeasurable when the project's data stops arriving while it waits for the finding", async () => {
    const w = world({ lastReceivedAgoMs: (now) => (now > START + MINUTE ? now - (START + MINUTE) : 10_000) });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/stopped arriving/);
  });

  it("is unmeasurable when the project's data stops arriving while it waits for the recovery", async () => {
    let off = Number.POSITIVE_INFINITY;
    const w = world({
      ...passing,
      verification: (_now, offAt) => {
        off = offAt;
        return { conclusion: "inconclusive", waitingCouldHelp: true };
      },
      lastReceivedAgoMs: (now) => (now > off + MINUTE ? now - (off + MINUTE) : 10_000),
    });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/stopped arriving/);
  });

  it("retries switching off, and a refusal that passes does not cost the night", async () => {
    const w = world({ ...passing, putFails: (_patch, index) => index === 1 });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.switchedOff).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(w.state.n_plus_one.enabled).toBe(false);
  });

  it("fails, and says so first, when the regression went on and cannot be switched off", async () => {
    const w = world({ ...passing, putFails: (patch) => Object.values(patch).some((p) => p.enabled === false) });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.switchedOff).toBe(false);
    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/^could not switch n_plus_one off/);
    expect(w.state.n_plus_one.enabled).toBe(true);
  });

  it("answers, and switches the regression off, when the canary itself breaks mid-cycle", async () => {
    const w = world({ ...passing, sleepThrowsAt: START + 3 * MINUTE });
    const result = await runCycle("n_plus_one", config, w.deps);

    expect(result.outcome).toBe("unmeasurable");
    expect(result.reason).toMatch(/the canary itself failed: the clock broke/);
    expect(w.state.n_plus_one.enabled).toBe(false);
    expect(result.switchedOff).toBe(true);
  });

  it("names the regression and the instants of the cycle whatever the outcome", async () => {
    const w = world({ appDown: true });
    const result = await runCycle("new_error", config, w.deps);

    expect(result.regression).toBe("new_error");
    expect(result.startedAt).toBe(new Date(START).toISOString());
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(START);
  });
});
