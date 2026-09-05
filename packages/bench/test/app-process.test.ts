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
    expect(summarizeErrorLine(line)).toBe("503 GET /me ColdStartError: database not ready yet");
  });

  it("copes with partial JSON: no route, empty message", () => {
    expect(summarizeErrorLine(JSON.stringify({ status: 500, error: "TypeError", message: "" }))).toBe("500 TypeError");
    expect(summarizeErrorLine(JSON.stringify({ status: 502, error: "ProviderError" }))).toBe("502 ProviderError");
  });

  it("keeps lines that are not the app's error format, truncated to 200 characters", () => {
    expect(summarizeErrorLine("Warning: something else on stderr")).toBe("Warning: something else on stderr");
    expect(summarizeErrorLine(JSON.stringify({ msg: "not an error line" }))).toBe('{"msg":"not an error line"}');
    const long = "x".repeat(250);
    expect(summarizeErrorLine(long)).toBe(`${"x".repeat(200)}…`);
  });

  it("caps the lines kept per round at a small number", () => {
    expect(MAX_ERROR_LINES).toBe(5);
  });
});
