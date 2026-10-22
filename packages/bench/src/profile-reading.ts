import type { ProfileFunction, ProfileGroupTotal } from "./cpu-profile.ts";
import type { BenchReport } from "./report.ts";
import { round } from "./stats.ts";

/** The profile campaign's reading and its Markdown, apart from the CLI that runs it so a test can call them (DT-21). */

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

export interface ProfileSide {
  ok: true;
  /** How many rounds this half profiled: how many processes' profiles the reading sums. */
  files: number;
  windowMs: number;
  idleMs: number;
  totalMs: number;
  samples: number;
  groups: ProfileGroupTotal[];
  top: ProfileFunction[];
}

export type ProfileSideReading = ProfileSide | { ok: false; reason: string };

export interface ProfileHooks {
  /** The agent's own estimate of its hooks, in ms of CPU per request (ADR 0080). */
  hookMsPerRequest?: number | undefined;
  /** What the estimate puts inside the hooks, in points of one core at this run's rate. */
  insideHooksPp?: number | undefined;
  /** The pair's measured CPU, agent minus baseline, in points of one core. */
  deltaCpuPp?: number | undefined;
  /** The measured cost the estimate does not account for: it runs outside the hooks. */
  outsideHooksPp?: number | undefined;
  reason?: string | undefined;
}

export interface ProfileReading {
  kind: "profile";
  generatedAt: string;
  subject?: BenchReport["subject"] | undefined;
  host?: BenchReport["host"] | undefined;
  node: string;
  platform: string;
  config: { rounds: number; measureSec: number; rps: number; seed: number };
  baseline: ProfileSideReading;
  agent: ProfileSideReading;
  /** The hook estimate beside the measured pair, in the same unit: where the inside/outside line comes from. */
  hooks: ProfileHooks;
  /** Why no round was measured, when the run is that. */
  reason?: string | undefined;
}

/** The inside/outside line, over the measured pairs: the estimate in the batch, the CPU in the sampler. */
export function hooksOf(report: BenchReport): ProfileHooks {
  const baseline = report.rounds.filter((r) => r.variant === "baseline");
  const agent = report.rounds.filter((r) => r.variant === "agent");
  const pairs = Math.min(baseline.length, agent.length);
  if (pairs === 0) return { reason: "no measured pair: the estimate has nothing to stand beside" };
  // Paired round by round, like every comparison this package makes: the pairs saw the same machine, and the
  // difference is averaged over the pairs rather than read from one of them.
  let deltaSum = 0;
  for (let i = 0; i < pairs; i++) {
    deltaSum += (agent[i]?.usage.cpuPct ?? 0) - (baseline[i]?.usage.cpuPct ?? 0);
  }
  const delta = round(deltaSum / pairs, 3);
  const estimates = agent.map((r) => r.sink?.hookMsPerRequest).filter((v): v is number => v !== undefined);
  if (estimates.length === 0) {
    return {
      deltaCpuPp: delta,
      reason:
        "the agent's rounds did not report their own hook estimate, so only the measured side of the line is said",
    };
  }
  const hookMs = round(estimates.reduce((x, y) => x + y, 0) / estimates.length, 4);
  // A point of one core is 10 ms of CPU per second; at `rps` requests a second, ms of CPU per request is
  // points of a core times ten over the rate — the same arithmetic the campaign's report reads (gh-570) — so
  // points are ms per request times the rate over ten. Over a thousand is the fraction of a core, not points
  // (DT-21).
  const inside = round((hookMs * report.config.rps) / 10, 3);
  return {
    hookMsPerRequest: hookMs,
    insideHooksPp: inside,
    deltaCpuPp: delta,
    outsideHooksPp: round(delta - inside, 3),
  };
}

/** The markdown the campaign prints: the line, the groups, and the functions of the side that carries the agent. */
export function profileMarkdown(r: ProfileReading): string {
  const lines = [
    `### What runs outside the hooks, read by function · ${r.config.rounds} round(s) · ${r.config.rps} rps · ${r.config.measureSec}s measured`,
    "",
    "Both halves of the pair ran under the benchmark's load with `--cpu-prof`; the tables are the round's CPU",
    "by function, and the difference between them is what the agent adds to it. **This is a reading, not a",
    "verdict** of the budget: a profile of a pair says what that pair ran, and the budget is what the `bench",
    "campaign measures, the agent against no agent, over rounds.",
    "",
  ];
  if (r.reason !== undefined) {
    lines.push(`**${r.reason}**`, "");
    return lines.join("\n");
  }
  lines.push(hooksLine(r), "");
  if (r.baseline.ok && r.agent.ok && r.baseline.files === r.agent.files) {
    const baseline = r.baseline;
    const agent = r.agent;
    lines.push(
      "| Source of the CPU | Baseline (ms) | Agent (ms) | Δ (ms) |",
      "|---|---:|---:|---:|",
      ...baseline.groups.map((g, i) => {
        const other = agent.groups[i];
        // The difference runs agent minus baseline, the way the line above runs it: what the agent adds.
        const d = other !== undefined ? round(other.selfMs - g.selfMs, 1) : Number.NaN;
        return `| ${g.group} | ${g.selfMs} | ${other?.selfMs ?? "—"} | ${signed(d)} |`;
      }),
      "",
    );
  } else if (r.baseline.ok && r.agent.ok) {
    // The halves profiled different numbers of rounds: their windows are not the same length, and a
    // difference of two different windows is not a comparison.
    lines.push(
      `The halves profiled different numbers of rounds (${r.baseline.files} against ${r.agent.files}), so their windows are not the ` +
        "same length and the table does not subtract them.",
      "",
    );
  } else {
    lines.push(sideLine("baseline", r.baseline), sideLine("agent", r.agent), "");
  }
  const side = r.agent.ok ? r.agent : r.baseline.ok ? r.baseline : undefined;
  if (side) {
    const whose = side === r.agent ? "the agent's" : "the baseline's (the agent's side was not written)";
    lines.push(
      `#### The top functions of ${whose} side, by self time`,
      "",
      `The profile covers ${side.windowMs} ms of the process's life — warm-up and measured window, not only the ` +
        `${r.config.measureSec}s measured — of which the thread was idle for ${side.idleMs} ms. The idle is ` +
        `wall time, not CPU, and it is left out of the tables: the samples account for ${side.totalMs} ms of ` +
        `CPU in ${side.samples} samples.`,
      "",
      "| Function | Source | Self (ms) | % |",
      "|---|---|---:|---:|",
      ...side.top.map((f) => `| ${f.function} | ${f.group} | ${f.selfMs} | ${round(f.share * 100, 1)} |`),
      "",
    );
  }
  lines.push(
    "The raw profiles are kept beside this report, one file per profiled round: a doubt about a row is read out",
    "of them, not measured again.",
    "",
  );
  return lines.join("\n");
}

function sideLine(variant: string, side: ProfileSideReading): string {
  return side.ok
    ? `The ${variant} side: ${side.totalMs} ms of CPU in ${side.samples} samples.`
    : `The ${variant} side was not read: ${side.reason}.`;
}

function hooksLine(r: ProfileReading): string {
  const h = r.hooks;
  if (h.hookMsPerRequest === undefined || h.deltaCpuPp === undefined) {
    return (
      `The pair's measured CPU is ${signed(h.deltaCpuPp ?? Number.NaN)} pp of one core.` +
      (h.reason !== undefined ? ` ${h.reason}.` : "")
    );
  }
  const share =
    h.deltaCpuPp > 0 && h.outsideHooksPp !== undefined
      ? Math.round(((h.insideHooksPp ?? 0) / h.deltaCpuPp) * 100)
      : undefined;
  return (
    `The agent's own estimate of its hooks: ~${h.hookMsPerRequest} ms of CPU per request (sampled, ADR 0080), which is ` +
    `${h.insideHooksPp} pp of one core at ${r.config.rps} rps, against ${signed(h.deltaCpuPp)} pp measured over the pairs` +
    (share !== undefined && h.outsideHooksPp !== undefined
      ? ` — about ${share} % of the measured cost inside the hooks; ${signed(h.outsideHooksPp)} pp runs outside them.`
      : ".") +
    " It is a reading, said as one: the line the series reads is the campaign's." +
    (h.reason !== undefined ? ` ${h.reason}.` : "")
  );
}
