import { describe, expect, it } from "vitest";
import { groupOf, readCpuProfiles } from "../src/cpu-profile.ts";

/**
 * The profile the campaign reads (gh-592): the round's CPU by function, summed over the rounds the half
 * profiled. These are structures, not values: the test says the reading holds together, and what it does not
 * read is said, not parsed through.
 */

function frame(id: number, name: string, url: string, line: number, parent?: number) {
  return {
    id,
    callFrame: { functionName: name, url, lineNumber: line, columnNumber: 0 },
    ...(parent !== undefined ? { parent } : {}),
  };
}

function profileOf(
  samples: number[],
  timeDeltas: number[],
  nodes: ReturnType<typeof frame>[],
  startUs = 0,
  endUs = 10_000_000,
) {
  return JSON.stringify({ startTime: startUs, endTime: endUs, samples, timeDeltas, nodes });
}

const AGENT = "file:///app/packages/agent/src/context.ts";
const AGENT_FINE = "file:///app/packages/agent/src/fine.ts";
const APP = "file:///app/packages/reference-app/src/app.ts";
const PG = "file:///app/node_modules/pg/lib/client.js";
const NODE = "node:internal/http/server";
const GC = "";

describe("reading a cpu profile by function", () => {
  it("splits the window's CPU by self time, by group, and keeps the top functions", () => {
    const nodes = [
      frame(0, "(root)", "", -1),
      frame(1, "enterRequest", AGENT, 123, 0),
      frame(2, "operation", AGENT_FINE, 45, 0),
      frame(3, "handler", APP, 10, 0),
      frame(4, "Client.query", PG, 200, 0),
      frame(5, "parserOnHeadersComplete", NODE, 100, 0),
      frame(6, "(idle)", GC, -1, 0),
    ];
    // Samples sit on top of their frame; the deltas say how long. The deltas are wall clock, and the thread's
    // idle — the synthetic (idle) frame — is wall time, not CPU: it is reported and left out of the totals.
    const read = readCpuProfiles([profileOf([1, 2, 3, 4, 5, 6], [1_000, 2_000, 3_000, 4_000, 5_000, 4_000], nodes)]);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    const { summary } = read;
    expect(summary.files).toBe(1);
    expect(summary.samples).toBe(6);
    expect(summary.idleMs).toBe(4);
    expect(summary.totalMs).toBe(15);
    expect(summary.windowMs).toBe(10_000);
    const byName = new Map(summary.top.map((f) => [f.function, f]));
    expect(byName.get("parserOnHeadersComplete")?.selfMs).toBe(5);
    expect(byName.get("Client.query")?.selfMs).toBe(4);
    expect(byName.has("(idle)"), "the idle is not a function the CPU sat on").toBe(false);
    expect(byName.get("handler")?.selfMs).toBe(3);
    expect(byName.get("operation")?.selfMs).toBe(2);
    expect(byName.get("enterRequest")?.selfMs).toBe(1);
    expect(byName.get("enterRequest")?.share).toBeCloseTo(1 / 15);
    const byGroup = new Map(summary.groups.map((g) => [g.group, g]));
    expect(byGroup.get("agent")?.selfMs).toBe(3);
    expect(byGroup.get("application")?.selfMs).toBe(3);
    expect(byGroup.get("pg")?.selfMs).toBe(4);
    expect(byGroup.get("node")?.selfMs).toBe(5);
    expect(byGroup.get("runtime")?.selfMs).toBe(0);
    expect(byGroup.get("other")?.selfMs).toBe(0);
    // The top is by self time, and the share is of the whole window.
    expect(summary.top[0]?.function).toBe("parserOnHeadersComplete");
    const shares = summary.groups.reduce((a, g) => a + g.share, 0);
    expect(shares).toBeCloseTo(1);
  });

  it("sums the rounds of a half into one reading: the same frame of two processes is one row", () => {
    const nodes = [
      frame(0, "(root)", "", -1),
      frame(1, "enterRequest", AGENT, 123, 0),
      frame(2, "handler", APP, 10, 0),
    ];
    const read = readCpuProfiles([
      profileOf([1, 2], [1_000, 1_000], nodes, 0, 2_000_000),
      // The second process's node ids are its own; the frame is the same source, line and name.
      profileOf(
        [8, 9],
        [3_000, 1_000],
        [frame(7, "(root)", "", -1), frame(8, "handler", APP, 10, 7), frame(9, "enterRequest", AGENT, 123, 7)],
        3_000_000,
        4_000_000,
      ),
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    const { summary } = read;
    expect(summary.files).toBe(2);
    expect(summary.samples).toBe(4);
    expect(summary.totalMs).toBe(6);
    expect(summary.windowMs, "each file's window, added").toBe(3_000);
    const byName = new Map(summary.top.map((f) => [f.function, f]));
    expect(summary.top).toHaveLength(2);
    expect(byName.get("handler")?.selfMs).toBe(4);
    expect(byName.get("enterRequest")?.selfMs).toBe(2);
  });

  it("names an anonymous frame, and groups by what the source is", () => {
    const nodes = [frame(0, "(root)", "", -1), frame(1, "", AGENT, 12, 0)];
    const read = readCpuProfiles([profileOf([1], [1_000], nodes)]);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.summary.top[0]?.function).toBe("(anonymous)");
    expect(read.summary.top[0]?.group).toBe("agent");
  });

  it("says why when there is nothing to read, instead of a table of zeros", () => {
    expect(readCpuProfiles([]).ok).toBe(false);
  });

  it("says why when a profile was cut short or does not hold together", () => {
    const nodes = [frame(0, "(root)", "", -1), frame(1, "f", AGENT, 1, 0)];
    expect(readCpuProfiles(["{ not json"]).ok).toBe(false);
    expect(readCpuProfiles([JSON.stringify({ startTime: 0, endTime: 1, samples: [1], nodes })]).ok).toBe(false);
    expect(
      readCpuProfiles([JSON.stringify({ startTime: 0, endTime: 1, samples: [1, 2], timeDeltas: [1], nodes })]).ok,
    ).toBe(false);
    expect(readCpuProfiles([JSON.stringify({ startTime: 0, endTime: 1, samples: [1], timeDeltas: [1] })]).ok).toBe(
      false,
    );
    expect(
      readCpuProfiles([JSON.stringify({ startTime: 0, endTime: 1, samples: [9], timeDeltas: [1], nodes })]).ok,
    ).toBe(false);
    expect(
      readCpuProfiles([JSON.stringify({ startTime: 0, endTime: 1, samples: [1], timeDeltas: [1], nodes: [42] })]).ok,
    ).toBe(false);
  });
});

describe("where a frame's source puts it", () => {
  it("the agent, the application, the driver, the runtime, the rest", () => {
    expect(groupOf("file:///x/packages/agent/src/context.ts")).toBe("agent");
    expect(groupOf("file:///x/packages/reference-app/src/app.ts")).toBe("application");
    expect(groupOf("file:///x/node_modules/pg/lib/client.js")).toBe("pg");
    expect(groupOf("file:///x/node_modules/pg-pool/index.js")).toBe("pg");
    expect(groupOf("node:internal/http/server")).toBe("node");
    expect(groupOf("")).toBe("runtime");
    expect(groupOf("file:///x/node_modules/express/lib/router.js")).toBe("other");
  });
});
