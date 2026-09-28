/**
 * What a set of `--cpu-prof` files is worth to the question gh-592 asks — what runs outside the hooks — read
 * by function, the way the ticket says it is enough to read it.
 *
 * Each file is V8's own output of one process: a forest of call frames (`nodes`, each with its parent), the
 * sampled stack at every instant (`samples`, node ids) and how long each sample lasted (`timeDeltas`,
 * microseconds). The deltas are the main thread's wall clock, and Node marks the instants the thread did
 * nothing with a synthetic `(idle)` frame: that is time the process held, not CPU it spent, so it is not
 * counted as CPU and is reported apart — a machine at a tenth of a core would otherwise show nine tenths of
 * its own CPU as runtime. The self time of a function is the sum of the deltas of the samples that sat on top
 * of it; that is where the CPU went, no assumption about the shape of anything. The cumulative time is not
 * computed here: the question is where the CPU sat, and a frame that spends its time in its callees is not a
 * function that is expensive.
 *
 * A half of the pair may have profiled several rounds — every round is a fresh process under the same seeded
 * load — and the files of one half are summed into one reading: the CPU by function over that half's rounds.
 * The node ids of two processes are not comparable, so frames are keyed by what names them across processes —
 * source, line and name — and the same frame of two rounds is one row. What the reading is **not** is said by
 * its window: a reading of the rounds it holds, and the reader is the one who knows what a window is.
 */

/** What a frame's source is, so the table groups by what the line is about and not by path. */
export type ProfileGroup = "agent" | "application" | "pg" | "node" | "runtime" | "other";

export const PROFILE_GROUPS: readonly ProfileGroup[] = ["agent", "application", "pg", "node", "runtime", "other"];

export interface ProfileFunction {
  /** The name V8 had for the frame, or «(anonymous)» where it had none. */
  function: string;
  /** The source the frame came from, as the profile says it. */
  url: string;
  group: ProfileGroup;
  /** Self time, in milliseconds: the window's CPU that sat on top of this frame. */
  selfMs: number;
  /** The share of the profiled CPU time, 0..1. */
  share: number;
}

export interface ProfileGroupTotal {
  group: ProfileGroup;
  selfMs: number;
  share: number;
}

export interface ProfileSummary {
  /** How many profiled rounds the reading holds: how many processes' profiles it summed. */
  files: number;
  /** The window the profiles cover, in ms: warm-up and measured window of each round, added. */
  windowMs: number;
  /** How much of the window the thread was idle, in ms: wall time, not CPU; reported so the window and the CPU can be told apart. */
  idleMs: number;
  /** CPU time the samples account for, in ms: the sum of the deltas, idle not among them. */
  totalMs: number;
  /** How many samples the window held, idle among them. */
  samples: number;
  /** The window's CPU by source, in the order the report prints it. */
  groups: ProfileGroupTotal[];
  /** The functions the CPU sat on most, by self time. */
  top: ProfileFunction[];
}

/** The profiles read, or why they could not be: an unreadable file is said, not parsed through. */
export type CpuProfileReading = { ok: true; summary: ProfileSummary } | { ok: false; reason: string };

interface CpuNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
}

interface CpuProfile {
  startTime?: number;
  endTime?: number;
  samples?: number[];
  timeDeltas?: number[];
  nodes?: CpuNode[];
}

/** Where a frame's source puts it. Paths, not guesses: the agent's files, the application's, the driver's. */
export function groupOf(url: string): ProfileGroup {
  if (url.includes("agent/src/")) return "agent";
  if (url.includes("reference-app/src/")) return "application";
  if (url.includes("node_modules/pg/") || url.includes("node_modules/pg-")) return "pg";
  if (url.startsWith("node:")) return "node";
  if (url === "") return "runtime";
  return "other";
}

/**
 * Reads the `--cpu-prof` files of one half of the pair, summed. The files are Node's own output, but they are
 * input to this process, so each is checked by shape before it is believed: a profile that does not hold
 * together is a reason, not a table of zeros.
 */
export function readCpuProfiles(texts: readonly string[], opts: { top?: number | undefined } = {}): CpuProfileReading {
  if (texts.length === 0) return { ok: false, reason: "there is no profile to read" };
  const top = opts.top ?? 25;
  /** Self time per frame, keyed the way two processes agree about a frame: source, line, name. */
  const selfUs = new Map<string, number>();
  const frames = new Map<string, { url: string; name: string }>();
  let windowUs = 0;
  let idleUs = 0;
  let totalUs = 0;
  let samples = 0;

  for (const text of texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `a profile is not JSON: ${String(err)}` };
    }
    const profile = parsed as CpuProfile;
    if (!Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas)) {
      return { ok: false, reason: "a profile carries no samples or no deltas: it was cut short" };
    }
    if (profile.samples.length !== profile.timeDeltas.length) {
      return { ok: false, reason: "a profile's samples and deltas do not line up: it was cut short" };
    }
    if (!Array.isArray(profile.nodes)) return { ok: false, reason: "a profile carries no call frames" };
    const byId = new Map<number, CpuNode>();
    for (const node of profile.nodes) {
      if (typeof node?.id !== "number" || typeof node.callFrame !== "object" || node.callFrame === null) {
        return { ok: false, reason: "a profile's call frames do not hold together" };
      }
      byId.set(node.id, node);
    }
    if (typeof profile.startTime === "number" && typeof profile.endTime === "number") {
      windowUs += Math.max(0, profile.endTime - profile.startTime);
    }
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      const delta = profile.timeDeltas[i];
      if (typeof id !== "number" || typeof delta !== "number") {
        return { ok: false, reason: "a profile's samples and deltas do not hold together" };
      }
      const node = byId.get(id);
      if (node === undefined) return { ok: false, reason: "a profile samples a frame it does not carry" };
      const frame = node.callFrame;
      const url = typeof frame.url === "string" ? frame.url : "";
      const name =
        typeof frame.functionName === "string" && frame.functionName !== "" ? frame.functionName : "(anonymous)";
      const line = typeof frame.lineNumber === "number" ? frame.lineNumber : -1;
      samples += 1;
      // The thread doing nothing is not CPU: it is said, as its own number, and left out of every total.
      if (name === "(idle)") {
        idleUs += delta;
        continue;
      }
      const key = `${url}#${line}#${name}`;
      totalUs += delta;
      selfUs.set(key, (selfUs.get(key) ?? 0) + delta);
      frames.set(key, { url, name });
    }
  }

  const byGroup = new Map<ProfileGroup, number>();
  const functions: ProfileFunction[] = [];
  for (const [key, us] of selfUs) {
    const frame = frames.get(key);
    if (frame === undefined) return { ok: false, reason: "a profile's frames do not hold together" };
    const group = groupOf(frame.url);
    byGroup.set(group, (byGroup.get(group) ?? 0) + us);
    functions.push({
      function: frame.name,
      url: frame.url,
      group,
      selfMs: roundMs(us),
      share: totalUs > 0 ? us / totalUs : 0,
    });
  }
  functions.sort((a, b) => b.selfMs - a.selfMs || a.function.localeCompare(b.function));

  return {
    ok: true,
    summary: {
      files: texts.length,
      windowMs: roundMs(windowUs),
      idleMs: roundMs(idleUs),
      totalMs: roundMs(totalUs),
      samples,
      groups: PROFILE_GROUPS.map((group) => ({
        group,
        selfMs: roundMs(byGroup.get(group) ?? 0),
        share: totalUs > 0 ? (byGroup.get(group) ?? 0) / totalUs : 0,
      })),
      top: functions.slice(0, top),
    },
  };
}

/** Microseconds to milliseconds, to one decimal: the resolution the table has and the one it claims. */
function roundMs(us: number): number {
  if (Number.isNaN(us)) return Number.NaN;
  return Math.round((us / 1000) * 10) / 10;
}
