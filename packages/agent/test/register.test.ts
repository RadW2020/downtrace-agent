import { describe, expect, it } from "vitest";

describe("register entry point", () => {
  it("without configuration: loads, warns once, changes no globals", async () => {
    const before = Object.keys(globalThis).sort();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      delete process.env.DOWNTRACE_TOKEN;
      delete process.env.DOWNTRACE_URL;
      await import("../src/register.ts");
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.filter((l) => l.includes("[downtrace]"))).toHaveLength(1);
    expect(lines[0]).toMatch(/agent disabled: DOWNTRACE_TOKEN and DOWNTRACE_URL are not set/);
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });
});
