import type { AddressInfo } from "node:net";
import type { Regression } from "@downtrace/reference-app";
import { afterEach, describe, expect, it } from "vitest";
import type { CycleResult } from "../src/canary.ts";
import { regressionFor } from "../src/canary-expectations.ts";
import { canaryConfigFrom, createCanaryServer } from "../src/canary-server.ts";

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function result(regression: Regression): CycleResult {
  return {
    regression,
    outcome: "pass",
    reason: "ok",
    startedAt: "2026-10-02T01:00:00.000Z",
    endedAt: "2026-10-02T01:30:00.000Z",
    enabledAt: null,
    detectedAt: null,
    disabledAt: null,
    recoveredAt: null,
    minutesToDetect: null,
    minutesToRecover: null,
    finding: null,
    openedInstead: [],
    lastVerification: null,
    switchedOff: true,
  };
}

async function serve(run: (r: Regression) => Promise<CycleResult>): Promise<string> {
  const server = createCanaryServer({ run, log: () => {}, now: () => new Date("2026-10-02T01:00:00Z") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, body: string) =>
  fetch(`${base}/cycle`, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("createCanaryServer", () => {
  it("runs one cycle of the regression asked for and answers its result", async () => {
    const asked: Regression[] = [];
    const base = await serve(async (r) => {
      asked.push(r);
      return result(r);
    });
    const res = await post(base, JSON.stringify({ regression: "pool_leak" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ regression: "pool_leak", outcome: "pass" });
    expect(asked).toEqual(["pool_leak"]);
  });

  it("runs tonight's regression when the body names none: the rotation lives with the list", async () => {
    const asked: Regression[] = [];
    const base = await serve(async (r) => {
      asked.push(r);
      return result(r);
    });
    expect((await post(base, "{}")).status).toBe(200);
    expect(asked).toEqual([regressionFor(new Date("2026-10-02T01:00:00Z"))]);
  });

  it("refuses a regression the reference app does not have, and a body that is not JSON", async () => {
    const base = await serve(async (r) => result(r));
    expect((await post(base, JSON.stringify({ regression: "drop_tables" }))).status).toBe(400);
    expect((await post(base, "{not json")).status).toBe(400);
    expect((await post(base, JSON.stringify(["n_plus_one"]))).status).toBe(400);
  });

  it("refuses a second cycle while one is running: two regressions at once would measure each other", async () => {
    let finish: (r: CycleResult) => void = () => {};
    const base = await serve((r) => new Promise((resolve) => (finish = () => resolve(result(r)))));
    const first = post(base, JSON.stringify({ regression: "n_plus_one" }));
    await new Promise((r) => setTimeout(r, 50));

    const second = await post(base, JSON.stringify({ regression: "new_error" }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ running: "n_plus_one" });

    finish(result("n_plus_one"));
    expect((await first).status).toBe(200);
    const health = await (await fetch(`${base}/healthz`)).json();
    expect(health).toEqual({ status: "ok", running: null });
  });

  it("answers 500 with the error when the cycle itself throws, and is free for the next one", async () => {
    let calls = 0;
    const base = await serve(async (r) => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return result(r);
    });
    const failed = await post(base, JSON.stringify({ regression: "n_plus_one" }));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "boom" });
    expect((await post(base, JSON.stringify({ regression: "n_plus_one" }))).status).toBe(200);
  });

  it("answers 404 for anything else", async () => {
    const base = await serve(async (r) => result(r));
    expect((await fetch(`${base}/cycle`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("canaryConfigFrom", () => {
  const env = {
    CANARY_APP_URL: "http://app:4000",
    CANARY_CLOUD_URL: "https://cloud.test/",
    CANARY_PROJECT: "canary",
    CANARY_TOKEN: "dt_read",
  };

  it("takes the defaults for what is not set, and trims the trailing slash of the URLs", () => {
    expect(canaryConfigFrom(env)).toEqual({
      port: 8080,
      cycle: {
        appUrl: "http://app:4000",
        cloudUrl: "https://cloud.test",
        project: "canary",
        token: "dt_read",
        pollMs: 60_000,
        detectWithinMs: 45 * 60_000,
        recoverWithinMs: 60 * 60_000,
        requestTimeoutMs: 20_000,
        freshWithinMs: 2 * 60_000,
      },
    });
  });

  it("refuses to start without what it cannot default", () => {
    for (const missing of ["CANARY_APP_URL", "CANARY_CLOUD_URL", "CANARY_PROJECT", "CANARY_TOKEN"]) {
      const partial: Record<string, string> = { ...env };
      delete partial[missing];
      expect(() => canaryConfigFrom(partial), missing).toThrow(missing);
    }
  });

  it("refuses a number that is not a positive integer instead of falling back without a word", () => {
    expect(() => canaryConfigFrom({ ...env, CANARY_POLL_SECONDS: "0" })).toThrow("CANARY_POLL_SECONDS");
    expect(() => canaryConfigFrom({ ...env, CANARY_DETECT_WITHIN_MINUTES: "soon" })).toThrow(
      "CANARY_DETECT_WITHIN_MINUTES",
    );
  });
});
