import { describe, expect, it } from "vitest";
import {
  configFromEnv,
  DEFAULT_INTERVAL_MS,
  detectVersion,
  INSTRUMENTS,
  parseInstruments,
  parsePgDepth,
  parseShed,
  profileCeilingMs,
} from "../src/config.ts";
import { Sheddable } from "../src/overhead.ts";
import { PROFILE_WINDOW_MS } from "../src/profile.ts";

describe("configFromEnv", () => {
  it("is disabled without token or url, with a precise reason", () => {
    expect(configFromEnv({})).toEqual({ ok: false, reason: "DOWNTRACE_TOKEN and DOWNTRACE_URL are not set" });
    expect(configFromEnv({ DOWNTRACE_URL: "http://x" })).toEqual({ ok: false, reason: "DOWNTRACE_TOKEN is not set" });
    expect(configFromEnv({ DOWNTRACE_TOKEN: "t" })).toEqual({ ok: false, reason: "DOWNTRACE_URL is not set" });
    expect(configFromEnv({ DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "ftp://x" }).ok).toBe(false);
  });

  it("applies defaults and normalises the url", () => {
    const r = configFromEnv({ DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "https://ingest.example.com/" });
    expect(r.ok && r.config).toMatchObject({
      token: "t",
      url: "https://ingest.example.com",
      environment: "production",
      version: "unknown",
      debug: false,
      intervalMs: DEFAULT_INTERVAL_MS,
      profileMs: PROFILE_WINDOW_MS,
      // Production does not move: a switch nobody set is the observer as it is (gh-592).
      pgDepth: "full",
    });
  });

  it("reads environment, debug and a bounded interval", () => {
    const r = configFromEnv({
      DOWNTRACE_TOKEN: "t",
      DOWNTRACE_URL: "http://x",
      NODE_ENV: "staging",
      DOWNTRACE_DEBUG: "1",
      DOWNTRACE_INTERVAL_MS: "2000",
    });
    expect(r.ok && r.config).toMatchObject({ environment: "staging", debug: true, intervalMs: 2000 });
    const tooSmall = configFromEnv({ DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "http://x", DOWNTRACE_INTERVAL_MS: "10" });
    expect(tooSmall.ok && tooSmall.config.intervalMs).toBe(DEFAULT_INTERVAL_MS);
  });

  it("detects the deploy version from common platform variables, in order", () => {
    expect(detectVersion({})).toBe("unknown");
    expect(detectVersion({ VERCEL_GIT_COMMIT_SHA: "abc" })).toBe("abc");
    expect(detectVersion({ VERCEL_GIT_COMMIT_SHA: "abc", DOWNTRACE_VERSION: "v1" })).toBe("v1");
    expect(detectVersion({ GIT_SHA: "  8f71ac  " })).toBe("8f71ac");
  });
});

describe("whether Node keeps the main module's symlinks (DT-34)", () => {
  const inspecting = { DOWNTRACE_INSPECT: "stderr" };
  function preserves(env: NodeJS.ProcessEnv, execArgv: readonly string[]): boolean {
    const r = configFromEnv(env, execArgv);
    if (!r.ok) throw new Error(r.reason);
    return r.config.preserveSymlinksMain;
  }

  it("is off by default, which is Node's default: the main module runs from its realpath", () => {
    expect(preserves(inspecting, [])).toBe(false);
  });

  it("is read from NODE_OPTIONS and from the command line, which comes after it", () => {
    expect(preserves({ ...inspecting, NODE_OPTIONS: "--preserve-symlinks-main" }, [])).toBe(true);
    expect(preserves(inspecting, ["--preserve-symlinks-main"])).toBe(true);
    expect(
      preserves({ ...inspecting, NODE_OPTIONS: "--preserve-symlinks-main" }, ["--no-preserve-symlinks-main"]),
    ).toBe(false);
  });
});

describe("which observers to run", () => {
  it("runs everything by default, and when asked for all", () => {
    expect([...parseInstruments(undefined)].sort()).toEqual([...INSTRUMENTS].sort());
    expect([...parseInstruments("all")].sort()).toEqual([...INSTRUMENTS].sort());
    expect([...parseInstruments("")].sort()).toEqual([...INSTRUMENTS].sort());
  });

  it("still understands none, which is what the documented switch has always meant", () => {
    expect([...parseInstruments("none")]).toEqual([]);
  });

  it("takes a list, so each observer's cost can be measured on its own", () => {
    expect([...parseInstruments("pg,http")].sort()).toEqual(["http", "pg"]);
    expect([...parseInstruments(" PG , Redis ")].sort()).toEqual(["pg", "redis"]);
  });

  it("ignores names it does not know rather than failing to start", () => {
    expect([...parseInstruments("pg,cassandra")]).toEqual(["pg"]);
    expect([...parseInstruments("nonsense")]).toEqual([]);
  });
});

/**
 * The floor under the meter's shedding level (gh-570): the benchmark's switch for weighing the fine detail and
 * the profile on their own. It reads like `DOWNTRACE_INSTRUMENT`: forgiving about case and spaces, and an
 * unknown value means the default rather than a refusal to start.
 */
describe("DOWNTRACE_SHED", () => {
  it("gives up nothing by default", () => {
    expect(parseShed(undefined)).toBe(Sheddable.Nothing);
    expect(parseShed("")).toBe(Sheddable.Nothing);
    expect(parseShed("nothing")).toBe(Sheddable.Nothing);
  });

  it("holds the fine detail, or the fine detail and the profile", () => {
    expect(parseShed("fine")).toBe(Sheddable.Fine);
    expect(parseShed(" Profile ")).toBe(Sheddable.Profile);
  });

  it("ignores a value it does not know rather than failing to start", () => {
    expect(parseShed("everything")).toBe(Sheddable.Nothing);
  });

  it("reaches the configuration", () => {
    const result = configFromEnv({ DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "http://c", DOWNTRACE_SHED: "fine" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.config.shed).toBe(Sheddable.Fine);
  });
});

/**
 * How much of the Postgres observer runs (gh-592): the benchmark's switch for weighing the observer part by
 * part, beside `DOWNTRACE_SHED`. It reads like its neighbours: forgiving about case and spaces, and an
 * unknown value means the observer as it is rather than a refusal to start.
 */
describe("DOWNTRACE_PG_DEPTH", () => {
  it("is the full observer by default", () => {
    expect(parsePgDepth(undefined)).toBe("full");
    expect(parsePgDepth("")).toBe("full");
    expect(parsePgDepth("full")).toBe("full");
  });

  it("weighs the observer below its text, or at its floor", () => {
    expect(parsePgDepth("context")).toBe("context");
    expect(parsePgDepth(" Wrapper ")).toBe("wrapper");
  });

  it("ignores a value it does not know rather than failing to start", () => {
    expect(parsePgDepth("everything")).toBe("full");
  });

  it("reaches the configuration", () => {
    const result = configFromEnv({ DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "http://c", DOWNTRACE_PG_DEPTH: "wrapper" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.config.pgDepth).toBe("wrapper");
  });
});

describe("DOWNTRACE_QUERY_TEXT", () => {
  const base = { DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "http://c" };
  const queryTextOf = (env: NodeJS.ProcessEnv): boolean => {
    const result = configFromEnv(env);
    if (!result.ok) throw new Error(result.reason);
    return result.config.queryText;
  };

  it("sends the normalised text unless told not to", () => {
    expect(queryTextOf(base)).toBe(true);
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: "on" })).toBe(true);
  });

  it("suppresses it on `off`, however it is written", () => {
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: "off" })).toBe(false);
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: "OFF" })).toBe(false);
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: " off " })).toBe(false);
  });

  it("treats anything else as leaving it on, rather than guessing", () => {
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: "no" })).toBe(true);
    expect(queryTextOf({ ...base, DOWNTRACE_QUERY_TEXT: "" })).toBe(true);
  });
});

describe("the profile's cadence", () => {
  const base = { DOWNTRACE_TOKEN: "t", DOWNTRACE_URL: "https://cloud.example" };
  const readResult = (env: Record<string, string>) => {
    const out = configFromEnv({ ...base, ...env });
    if (!out.ok) throw new Error(out.reason);
    return out;
  };
  const read = (env: Record<string, string>) => readResult(env).config;

  // Production does not move. ADR 0017 fixed the minute because the profile's rows count against the project's
  // daily budget, and gh-565 made it overridable without touching the number.
  it("is a minute when nobody says otherwise", () => {
    expect(read({}).profileMs).toBe(PROFILE_WINDOW_MS);
  });

  it("takes the value it is given", () => {
    expect(read({ DOWNTRACE_PROFILE_MS: "2000", DOWNTRACE_INTERVAL_MS: "1000" }).profileMs).toBe(2000);
  });

  // The floor is the aggregation interval, and it is derived rather than chosen: the profile rotates on each
  // flush, so a window shorter than the interval that feeds it closes on the very same flush as one equal to
  // it. A number below that is not a faster cadence, it is a number that says nothing.
  it("is never shorter than the interval that feeds it", () => {
    const c = read({ DOWNTRACE_PROFILE_MS: "500", DOWNTRACE_INTERVAL_MS: "1000" });
    expect(c.profileMs).toBe(c.intervalMs);
  });

  // The ceiling is derived the same way the floor is, from the window that reads the profile (gh-716): the
  // report's diff reads the recent window as the last five minutes, ending one minute ago — the minute being
  // the arrival budget, what is flushed by then has arrived by the check — and it counts a profile on the
  // side where it starts. A window that starts at s has arrived by the check only once it has closed and was
  // flushed at least a minute earlier: the first flush after s + profileMs, at most one interval later. The
  // starts a check can still read lie in a span of five minutes minus profileMs minus intervalMs, and starts
  // come one per closed window, spaced at most profileMs + intervalMs apart. For at least one to fall in
  // that span at every phase, two windows with their two flushes must fit in the five minutes:
  // 2 * (profileMs + intervalMs) <= 5 * 60_000.
  it("is never longer than the ceiling derived from the window that reads it", () => {
    const c = read({ DOWNTRACE_PROFILE_MS: "600000", DOWNTRACE_INTERVAL_MS: "10000" });
    expect(c.profileMs).toBe(140000);
  });

  it("takes the value at the ceiling, with no warning", () => {
    const result = readResult({ DOWNTRACE_PROFILE_MS: "140000", DOWNTRACE_INTERVAL_MS: "10000" });
    expect(result.config.profileMs).toBe(140000);
    expect(result.warnings).toEqual([]);
  });

  it("moves the ceiling with the interval that feeds it", () => {
    const c = read({ DOWNTRACE_PROFILE_MS: "600000", DOWNTRACE_INTERVAL_MS: "1000" });
    expect(c.profileMs).toBe(149000);
  });

  it("clamps a value above the ceiling and says so once at start-up", () => {
    const result = readResult({ DOWNTRACE_PROFILE_MS: "600000", DOWNTRACE_INTERVAL_MS: "10000" });
    expect(result.config.profileMs).toBe(140000);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("DOWNTRACE_PROFILE_MS=600000");
    expect(result.warnings[0]).toContain("140000");
  });

  it("says nothing when the value is inside the floor and the ceiling", () => {
    const result = readResult({ DOWNTRACE_PROFILE_MS: "2000", DOWNTRACE_INTERVAL_MS: "1000" });
    expect(result.config.profileMs).toBe(2000);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the default when the value is not a positive whole number", () => {
    for (const value of ["", "abc", "0", "-1", "1500.5"]) {
      expect(read({ DOWNTRACE_PROFILE_MS: value }).profileMs, value).toBe(PROFILE_WINDOW_MS);
    }
  });
});

/**
 * The arithmetic the ceiling is derived against (gh-716). The window it is derived from lives in the cloud,
 * in the detector's geometry, and this package does not import it; this test pins it the way the detector's
 * own test pins its own windows, so the derivation and its test cannot drift apart.
 */
describe("the ceiling's arithmetic, against the window that reads it", () => {
  // The reader's window: the last five minutes, ending one minute ago. The minute is the arrival budget —
  // what is flushed by then has arrived by the check — and it shifts the span of readable starts without
  // changing its width, so it does not enter the arithmetic below. It lives in the cloud, in the detector's
  // geometry, and this package does not import it (gh-716).
  const RECENT_MS = 5 * 60_000;

  // A profile window is counted on the side where it starts, and it has arrived by the check only once it
  // was flushed at least the lag earlier: the first flush after start + P, at most one interval later. So
  // the starts a check can still read lie in a span of RECENT − P − I, and starts come one per closed
  // window, spaced at most P + I apart. The worst phase holds the floor of that division: below it, a phase
  // exists in which the report's window holds no profile that has arrived, and the report says
  // `no-profile-after` of a route that was profiled as asked.
  const minimumReadable = (profileMs: number, intervalMs: number): number =>
    Math.max(0, Math.floor((RECENT_MS - profileMs - intervalMs) / (profileMs + intervalMs)));

  it("at the ceiling, one profile window is readable at every phase", () => {
    for (const intervalMs of [1_000, 10_000, 60_000]) {
      const ceiling = profileCeilingMs(intervalMs);
      expect(minimumReadable(ceiling, intervalMs), `interval ${intervalMs}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("with the default cadence, several profile windows are", () => {
    expect(minimumReadable(PROFILE_WINDOW_MS, DEFAULT_INTERVAL_MS)).toBeGreaterThanOrEqual(2);
  });

  it("above the ceiling, phases hold none: the ticket's 600000 and the first millisecond over", () => {
    expect(minimumReadable(600_000, DEFAULT_INTERVAL_MS)).toBe(0);
    expect(minimumReadable(profileCeilingMs(DEFAULT_INTERVAL_MS) + 1, DEFAULT_INTERVAL_MS)).toBe(0);
  });
});
