import { describe, expect, it } from "vitest";
import { type MachineCpu, otherCpuPct, parseProcStat } from "../src/machine.ts";

/**
 * The benchmark shares a machine with the rest of CI, and its round collapses lined up one-to-one with the
 * neighbouring runner's jobs (gh-200). Nobody saw it for weeks because the report said nothing about the machine.
 */

// Two readings of /proc/stat, one second apart on a 4-core machine. Fields: user nice system idle iowait irq
// softirq steal guest guest_nice, in USER_HZ (100 per second).
const stat = (busy: number, idle: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0
cpu0 1 0 0 1 0 0 0 0 0 0
intr 12345
ctxt 67890
`;

describe("parseProcStat", () => {
  it("separates the time the machine worked from the time it waited", () => {
    const parsed = parseProcStat(stat(400, 1600));
    expect(parsed).toEqual({ busyJiffies: 400, idleJiffies: 1600 });
  });

  it("counts iowait as idle, because a machine waiting for a disk is not one competing for CPU", () => {
    const parsed = parseProcStat("cpu  100 0 50 800 200 0 0 0 0 0\n");
    expect(parsed?.busyJiffies).toBe(150);
    expect(parsed?.idleJiffies).toBe(1000);
  });

  it("has no answer rather than a wrong one when the shape is not what it expects", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("not a proc stat at all\n")).toBeUndefined();
    expect(parseProcStat("cpu  100 0\n")).toBeUndefined();
  });
});

describe("otherCpuPct", () => {
  const machine = (busyStart: number, busyEnd: number, idleStart: number, idleEnd: number): MachineCpu => ({
    start: { busyJiffies: busyStart, idleJiffies: idleStart },
    end: { busyJiffies: busyEnd, idleJiffies: idleEnd },
  });

  it("is what was busy that this benchmark did not account for", () => {
    // One wall second on a four-core box, fully busy: 400 jiffies of work, of which the app used 25 % of a core.
    expect(otherCpuPct(machine(0, 400, 0, 0), 25, 1000)).toBeCloseTo(375, 5);
  });

  it("reads a quiet machine as quiet", () => {
    // One wall second, 20 jiffies of work in the whole machine, and the app is nearly all of it.
    expect(otherCpuPct(machine(0, 20, 0, 380), 15, 1000)).toBeCloseTo(5, 5);
  });

  it("is zero, not negative, when the benchmark accounts for everything", () => {
    // Rounding and sampling skew can make the app's share look larger than the machine's. Below zero is not a
    // reading, it is noise, and reporting a negative neighbour would be worse than saying nothing.
    expect(otherCpuPct(machine(0, 20, 0, 380), 25, 1000)).toBe(0);
  });

  it("has no answer when the counters did not advance", () => {
    // Nothing observed is not the same as nothing happening.
    expect(otherCpuPct(machine(100, 100, 100, 100), 10, 1000)).toBeUndefined();
    expect(otherCpuPct(machine(0, 400, 0, 0), 25, 0)).toBeUndefined();
  });

  it("scales with the window, so a longer round does not look busier", () => {
    const oneSecond = otherCpuPct(machine(0, 200, 0, 200), 0, 1000);
    const tenSeconds = otherCpuPct(machine(0, 2000, 0, 2000), 0, 10_000);
    expect(oneSecond).toBeCloseTo(tenSeconds ?? -1, 5);
  });
});

// The load generator and the sink run in the benchmark's own process. Counting only the application under test
// would report the benchmark to itself as a neighbour (gh-200).
describe("what counts as this benchmark", () => {
  it("subtracts everything the benchmark runs, not only the application", () => {
    const busy = { start: { busyJiffies: 0, idleJiffies: 0 }, end: { busyJiffies: 100, idleJiffies: 300 } };
    const appOnly = otherCpuPct(busy, 40, 1000);
    const appAndGenerator = otherCpuPct(busy, 40 + 35, 1000);
    expect(appOnly).toBeCloseTo(60, 5);
    expect(appAndGenerator).toBeCloseTo(25, 5);
  });
});
