import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_INTERVAL_MS, detectVersion, INSTRUMENTS, parseInstruments } from "../src/config.ts";
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
  const read = (env: Record<string, string>) => {
    const out = configFromEnv({ ...base, ...env });
    if (!out.ok) throw new Error(out.reason);
    return out.config;
  };

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

  it("falls back to the default when the value is not a positive whole number", () => {
    for (const value of ["", "abc", "0", "-1", "1500.5"]) {
      expect(read({ DOWNTRACE_PROFILE_MS: value }).profileMs, value).toBe(PROFILE_WINDOW_MS);
    }
  });
});
