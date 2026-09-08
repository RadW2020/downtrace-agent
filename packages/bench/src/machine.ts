import { readFile } from "node:fs/promises";

/**
 * What the rest of the machine was doing while the benchmark measured.
 *
 * A comparison of two variants only means something if both saw the same machine, which is why the rounds
 * alternate. On a shared box that assumption breaks silently: the benchmark's round collapses turned out to line
 * up one-to-one with another CI runner's jobs on the same VM, and nothing in the report could have said so
 * because nothing in the report looked outside the benchmark's own processes (gh-200).
 *
 * Linux only, by reading /proc/stat. Anywhere else this reports that it does not know, which is not the same as
 * reporting a quiet machine.
 */

export interface CpuTime {
  busyJiffies: number;
  idleJiffies: number;
}

export interface MachineCpu {
  start: CpuTime;
  end: CpuTime;
}

/**
 * The aggregate `cpu` line of /proc/stat, split into work and waiting.
 *
 * `iowait` counts as idle: a machine waiting for a disk is not one competing for CPU, and counting it as work
 * would report a neighbour that is not there.
 */
export function parseProcStat(contents: string): CpuTime | undefined {
  const line = contents.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal — anything shorter is not the line this expects.
  if (fields.length < 8 || fields.some((n) => !Number.isFinite(n))) return undefined;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  return {
    busyJiffies: user + nice + system + irq + softirq + steal,
    idleJiffies: idle + iowait,
  };
}

/** Reads the machine's CPU time, or nothing where that cannot be read. */
export async function readCpuTime(): Promise<CpuTime | undefined> {
  try {
    return parseProcStat(await readFile("/proc/stat", "utf8"));
  } catch {
    // Not Linux, or /proc is not mounted. "We cannot see" is the honest answer and the caller reports it as such.
    return undefined;
  }
}

/** A jiffy is 1/100 of a CPU-second on every Linux this runs on; USER_HZ has been 100 for as long as it matters. */
const JIFFIES_PER_SECOND = 100;

/**
 * CPU used by everything that is not this benchmark, as a percentage of one core over the window.
 *
 * Expressed in the same unit as `cpuPct` so the two can be read side by side: 100 means one core's worth, and a
 * four-core machine fully busy reads 400. Undefined when the counters did not advance, which means nothing was
 * observed rather than that nothing happened.
 */
export function otherCpuPct(machine: MachineCpu, benchCpuPct: number, wallMs: number): number | undefined {
  // `benchCpuPct` must account for everything this benchmark runs — the application under test *and* the
  // generator and sink in this process — or what it does not cover comes back labelled as a neighbour.
  const busy = machine.end.busyJiffies - machine.start.busyJiffies;
  const moved = busy + (machine.end.idleJiffies - machine.start.idleJiffies);
  if (moved <= 0 || wallMs <= 0) return undefined;
  const machinePct = (busy / JIFFIES_PER_SECOND / (wallMs / 1000)) * 100;
  const other = machinePct - benchCpuPct;
  // Sampling skew can put the benchmark's own share above the machine's. Below zero is not a reading.
  return other > 0 ? other : 0;
}
