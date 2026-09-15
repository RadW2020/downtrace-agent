import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type KeptReport, reportFileName, reportMessage } from "../src/report-name.ts";

/**
 * The mirror keeps every report on `bench-reports` under a name that sorts and carries the version and the commit
 * (ADR 0134). The code that names it lived inside the workflow's YAML, where nothing ran it before the mirror did,
 * and an illegal `return` cost the series a point (gh-590). This runs it, for both kinds of report.
 */
const campaign: KeptReport = {
  generatedAt: "2026-09-15T13:00:05.123Z",
  subject: { version: "0.8.1", commit: "abcdef0123456789", sourceCommit: "bcc11dc9999999" },
  config: { rounds: 9, measureSec: 60, rps: 200 },
  verdict: "pass",
  metrics: [
    { metric: "p99Ms", delta: 0.888, unit: "ms", budget: 1, noise: 1.067, status: "ok" },
    { metric: "cpuPct", delta: 2.742, unit: "pp", budget: 3, noise: 1.299, status: "ok" },
    { metric: "rssMb", delta: -0.5, unit: "MiB", budget: 64, noise: 20.188, status: "ok" },
  ],
};

const instruments: KeptReport = {
  kind: "instruments",
  generatedAt: "2026-09-15T16:26:00.000Z",
  subject: { version: "0.8.1", commit: "1234567abcdef" },
  config: { rounds: 9, measureSec: 20, rps: 200 },
  steps: [
    { name: "the agent itself", cpuPp: 1.2, cpuNoise2se: 0.3, p: 0.0039, resolved: true },
    { name: "the fine detail", cpuPp: -0.05, cpuNoise2se: 0.4, p: 0.5, resolved: false },
  ],
};

describe("naming a kept report", () => {
  it("a campaign: stamp, agent, version and the monorepo commit when the sync left one", () => {
    expect(reportFileName(campaign)).toBe("2026-09-15T13-00-05Z-agent-0.8.1-bcc11dc.json");
    expect(reportMessage(campaign)).toBe(
      "bench: agent 0.8.1 — pass on 9×60s at 200 rps\n\n" +
        "p99Ms +0.888 ms (budget 1, noise 1.067) ok\n" +
        "cpuPct +2.742 pp (budget 3, noise 1.299) ok\n" +
        "rssMb -0.5 MiB (budget 64, noise 20.188) ok\n\n",
    );
  });

  it("a campaign with a reason carries it after the metrics", () => {
    const r: KeptReport = {
      ...campaign,
      verdict: "inconclusive",
      reason: "p99Ms is under the budget but its noise (1.067) exceeds the budget (1)",
    };
    expect(reportMessage(r)).toContain("— inconclusive on 9×60s");
    expect(reportMessage(r)).toMatch(/ok\n\np99Ms is under the budget[^\n]*\n\n$/);
  });

  it("an instruments run: named apart from the series, one line per step and how many were resolved", () => {
    expect(reportFileName(instruments)).toBe("2026-09-15T16-26-00Z-instruments-0.8.1-1234567.json");
    expect(reportMessage(instruments)).toBe(
      "bench-instruments: agent 0.8.1 — 1 of 2 resolved on 9×20s at 200 rps\n\n" +
        "the agent itself: ΔCPU +1.2 pp ± 0.3 (p 0.0039) resolved\n" +
        "the fine detail: ΔCPU -0.05 pp ± 0.4 (p 0.5) not resolved\n\n",
    );
  });

  it("says unknown when the report does not know its version or commit, instead of inventing one", () => {
    const r: KeptReport = { ...campaign, subject: undefined };
    expect(reportFileName(r)).toBe("2026-09-15T13-00-05Z-agent-unknown-unknown.json");
  });

  it("runs as the script the workflow calls: writes the message and prints the name", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-name-"));
    const reportPath = join(dir, "instruments-report.json");
    const messagePath = join(dir, "msg");
    writeFileSync(reportPath, JSON.stringify(instruments));
    const script = fileURLToPath(new URL("../src/report-name.ts", import.meta.url));
    const out = execFileSync(process.execPath, [script, reportPath, messagePath], { encoding: "utf8" });
    expect(out.trim()).toBe("2026-09-15T16-26-00Z-instruments-0.8.1-1234567.json");
    expect(readFileSync(messagePath, "utf8")).toBe(reportMessage(instruments));
  });

  it("as a script, refuses to run without its two arguments", () => {
    const script = fileURLToPath(new URL("../src/report-name.ts", import.meta.url));
    expect(() => execFileSync(process.execPath, [script], { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});
