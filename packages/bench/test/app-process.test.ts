import { describe, expect, it } from "vitest";
import { MAX_ERROR_LINES, startReferenceApp, summarizeErrorLine } from "../src/app-process.ts";

describe("summarizeErrorLine", () => {
  it("turns the reference app's JSON error line into one readable line", () => {
    const line = JSON.stringify({
      level: "error",
      status: 503,
      method: "GET",
      path: "/me",
      error: "ColdStartError",
      message: "database not ready yet",
    });
    expect(summarizeErrorLine(line)).toEqual({
      summary: "503 GET /me ColdStartError: database not ready yet",
      key: "503 ColdStartError",
    });
  });

  it("copes with partial JSON: no route, empty message", () => {
    expect(summarizeErrorLine(JSON.stringify({ status: 500, error: "TypeError", message: "" })).summary).toBe(
      "500 TypeError",
    );
    expect(summarizeErrorLine(JSON.stringify({ status: 502, error: "ProviderError" })).summary).toBe(
      "502 ProviderError",
    );
  });

  it("keeps lines that are not the app's error format, truncated to 200 characters", () => {
    expect(summarizeErrorLine("Warning: something else on stderr").summary).toBe("Warning: something else on stderr");
    expect(summarizeErrorLine(JSON.stringify({ msg: "not an error line" })).summary).toBe(
      '{"msg":"not an error line"}',
    );
    const long = "x".repeat(250);
    expect(summarizeErrorLine(long).summary).toBe(`${"x".repeat(200)}…`);
  });

  it("distinctness is status and error name, so one failure over many paths keeps one slot", () => {
    const of = (path: string) =>
      summarizeErrorLine(JSON.stringify({ status: 503, method: "GET", path, error: "ColdStartError" })).key;
    expect(of("/products/1")).toBe(of("/products/2"));
    expect(of("/products/1")).not.toBe(
      summarizeErrorLine(JSON.stringify({ status: 500, method: "GET", path: "/products/1", error: "ColdStartError" }))
        .key,
    );
  });

  it("caps the lines kept per round at a small number", () => {
    expect(MAX_ERROR_LINES).toBe(5);
  });
});

describe("startReferenceApp", () => {
  // The harness used to start the app with --env-file-if-exists on a gitignored file: present on one machine,
  // absent in CI, skipped in silence. And the app has defaults, so nothing complained — it just measured a
  // database nobody chose (gh-142, ADR 0023). Missing configuration has to stop the measurement, not colour it.
  it("refuses to start the app without the services it must measure against", async () => {
    const saved = { db: process.env.DATABASE_URL, redis: process.env.REDIS_URL };
    try {
      process.env.DATABASE_URL = "postgres://x/y";
      delete process.env.REDIS_URL;
      await expect(startReferenceApp()).rejects.toThrow("REDIS_URL is not set");

      delete process.env.DATABASE_URL;
      process.env.REDIS_URL = "redis://x";
      await expect(startReferenceApp()).rejects.toThrow("DATABASE_URL is not set");
    } finally {
      for (const [key, value] of [
        ["DATABASE_URL", saved.db],
        ["REDIS_URL", saved.redis],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
