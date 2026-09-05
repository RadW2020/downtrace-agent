import { describe, expect, it } from "vitest";
import { MAX_ERROR_LINES, summarizeErrorLine } from "../src/app-process.ts";

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
