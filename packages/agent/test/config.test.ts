import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_INTERVAL_MS, detectVersion } from "../src/config.ts";

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
