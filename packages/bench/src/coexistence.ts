import { METRICS, type MetricName, UNITS } from "./budget.ts";
import type { Host } from "./machine.ts";
import type { BenchReport, RoundResult } from "./report.ts";
import { gate, permutationP } from "./significance.ts";
import { round } from "./stats.ts";
import type { BenchSubject } from "./subject.ts";

/**
 * The reading of the coexistence campaign (ESC-16, gh-615): what it costs the application to have the agent and
 * the tracker loaded together, and what the agent's own estimate says in the two configurations.
 *
 * The campaign is one head-to-head comparison — the whole agent against the whole agent with the tracker loaded
 * beside it — and this module is what that comparison reads off the benchmark's report, with the bench's
 * existing rules: the deltas and their noise are what `evaluate` already computed (ADR 0137), and whether a row
 * is a measurement or the machine having a moment is a permutation test over the paired per-round differences,
 * at a level shared among the comparisons the run makes (ADR 0027).
 *
 * What this reading is **not**: a verdict of the budget. The budget of invariant 3 is the instrumentation's, and
 * it is what the `bench` campaign measures — the agent against no agent. Here both configurations carry the
 * agent, so the deltas are the tracker's cost, reported as such. The only claim against the budget the run can
 * make is the one the agent makes about itself: that its own hook estimate, sampled inside `guard` (ADR 0080),
 * does not move.
 */
export interface CoexistenceComparison {
  name: string;
  /** The module the agent side loaded beside the agent, recorded the way a report records a path (no home directory). */
  module: string;
  /** The tracker's pinned version, as the reference app's manifest names it; undefined when it could not be read. */
  version?: string | undefined;
}

export interface CoexistenceMetric {
  metric: MetricName;
  unit: string;
  /** How the two values were obtained: per-round medians, or one percentile over all pooled samples. */
  method: "pooled-p99" | "median-of-rounds";
  /** Samples behind each pooled value (per variant); absent for median-of-rounds. */
  samples?: number | undefined;
  /** What the agent alone cost, from the benchmark's own rule. */
  baseline: number;
  /** What the agent beside the tracker cost. */
  agent: number;
  /** The tracker's cost: agent beside the tracker, minus the agent alone. */
  delta: number;
  /** The noise the machine puts on this difference (ADR 0137). */
  noise: number;
  noiseSource?: "split-half" | "round-drift" | undefined;
  /** Paired per-round differences — the tracker's side minus the agent's alone — in round order. */
  differences: number[];
  p: number;
  /** False when the p value was sampled rather than enumerated. */
  exact: boolean;
  /** The p cleared the level shared among the comparisons of the run (ADR 0027). */
  resolved: boolean;
}

export interface CoexistenceHook {
  /** Mean of the per-round estimates each side reported, in ms of CPU per request; undefined when no round did. */
  baseline?: number | undefined;
  agent?: number | undefined;
  /** Paired per-round differences; empty when a pair is missing and the comparison is not made. */
  differences: number[];
  /** Pairs whose one side or the other did not report an estimate: not knowing is not zero (ADR 0093). */
  missing: number;
  p?: number | undefined;
  exact?: boolean | undefined;
  resolved: boolean;
  reason?: string | undefined;
}

export interface CoexistenceReading {
  kind: "coexistence";
  generatedAt: string;
  subject?: BenchSubject | undefined;
  host?: Host | undefined;
  node: string;
  platform: string;
  comparison: CoexistenceComparison;
  config: {
    rounds: number;
    measureSec: number;
    rps: number;
    seed: number;
    /** The comparisons the run makes: the deltas, one per metric, and the agent's own hook estimate. */
    comparisons: number;
    /** The level each comparison has to clear, shared among them (Bonferroni, ADR 0027). */
    alpha: number;
  };
  /** The tracker's cost, per metric. No budget, no status: this is what is reported, not what is judged. */
  metrics: CoexistenceMetric[];
  /** The agent's own estimate of its hooks, in the two configurations: the half of the clause that is ours. */
  hook: CoexistenceHook;
  /** What the tracker shipped to its local sink across the rounds that loaded it. */
  tracker: {
    envelopes: number;
    transactions: number;
    events: number;
    rejected: number;
    perRound: { round: number; envelopes: number; transactions: number; events: number }[];
  };
  /** Why no metric could be read, when the run is that: a round that never got clean. */
  reason?: string | undefined;
}

const METRIC_LABEL: Record<MetricName, string> = { p99Ms: "p99", cpuPct: "CPU", rssMb: "RSS" };

export function readCoexistence(
  report: BenchReport,
  comparison: CoexistenceComparison,
  comparisons: number,
): CoexistenceReading {
  const baseline = report.rounds.filter((r) => r.variant === "baseline");
  const agent = report.rounds.filter((r) => r.variant === "agent");
  const reading: CoexistenceReading = {
    kind: "coexistence",
    generatedAt: report.generatedAt,
    subject: report.subject,
    host: report.host,
    node: report.node,
    platform: report.platform,
    comparison,
    config: {
      rounds: report.config.rounds,
      measureSec: report.config.measureSec,
      rps: report.config.rps,
      seed: report.config.seed,
      comparisons,
      alpha: gate(1, comparisons).alpha,
    },
    metrics: [],
    hook: { differences: [], missing: 0, resolved: false, reason: "no round was measured" },
    tracker: trackerShipped(agent),
  };
  // A round that never got clean ends the benchmark before a metric exists: the run is its reason, and the
  // report keeps it rather than a table of NaNs.
  if (report.metrics.length === 0) {
    reading.reason = report.reason;
    return reading;
  }

  const perRound: Record<MetricName, (r: RoundResult) => number> = {
    p99Ms: (r) => r.load.overall.p99,
    cpuPct: (r) => r.usage.cpuPct,
    rssMb: (r) => r.usage.rssMaxMb,
  };
  reading.metrics = METRICS.map((metric): CoexistenceMetric => {
    const v = report.metrics.find((m) => m.metric === metric);
    const of = perRound[metric];
    // Paired, not pooled: the rounds alternate in time, so round i of one side and round i of the other saw
    // the same machine, and differencing them first removes most of what the machine was doing.
    const differences: number[] = [];
    for (let i = 0; i < Math.min(baseline.length, agent.length); i++) {
      const b = baseline[i];
      const a = agent[i];
      if (b === undefined || a === undefined) break;
      differences.push(of(a) - of(b));
    }
    const significance = permutationP(differences, { seed: report.config.seed });
    return {
      metric,
      unit: UNITS[metric],
      method: v?.method ?? "median-of-rounds",
      samples: v?.samples,
      baseline: v?.baselineMedian ?? Number.NaN,
      agent: v?.agentMedian ?? Number.NaN,
      delta: v?.delta ?? Number.NaN,
      noise: v?.noise ?? Number.NaN,
      noiseSource: v?.noiseSource,
      differences: differences.map((d) => round(d, 3)),
      p: significance.p,
      exact: significance.exact,
      resolved: v !== undefined && gate(significance.p, comparisons).resolved,
    };
  });

  // The agent's own estimate of its hooks, per round and per side: what the budget of invariant 3 is about.
  // It is sampled inside `guard` (ADR 0080), so the tracker's work cannot enter it by construction — the
  // question is only whether it moved, and the same rule decides it as the deltas: a permutation over the
  // paired differences at the shared level.
  const baselineEst = baseline.map((r) => r.sink?.hookMsPerRequest);
  const agentEst = agent.map((r) => r.sink?.hookMsPerRequest);
  const differences: number[] = [];
  let missing = 0;
  for (let i = 0; i < Math.min(baselineEst.length, agentEst.length); i++) {
    const b = baselineEst[i];
    const a = agentEst[i];
    if (b === undefined || a === undefined) {
      missing += 1;
      continue;
    }
    differences.push(a - b);
  }
  const mean = (xs: readonly number[]): number | undefined =>
    xs.length === 0 ? undefined : round(xs.reduce((x, y) => x + y, 0) / xs.length, 3);
  if (missing > 0) {
    reading.hook = {
      baseline: mean(baselineEst.filter((x): x is number => x !== undefined)),
      agent: mean(agentEst.filter((x): x is number => x !== undefined)),
      differences: [],
      missing,
      resolved: false,
      reason:
        `${missing} of ${Math.min(baselineEst.length, agentEst.length)} rounds did not report the agent's own ` +
        "estimate on one side: a paired comparison with holes is not a comparison",
    };
  } else {
    const significance = permutationP(differences, { seed: report.config.seed });
    reading.hook = {
      baseline: mean(baselineEst.filter((x): x is number => x !== undefined)),
      agent: mean(agentEst.filter((x): x is number => x !== undefined)),
      differences: differences.map((d) => round(d, 4)),
      missing,
      p: significance.p,
      exact: significance.exact,
      resolved: gate(significance.p, comparisons).resolved,
    };
  }

  return reading;
}

function trackerShipped(agentRounds: readonly RoundResult[]): CoexistenceReading["tracker"] {
  const perRound = agentRounds.map((r) => ({
    round: r.round,
    envelopes: r.tracker?.envelopes ?? 0,
    transactions: r.tracker?.transactions ?? 0,
    events: r.tracker?.events ?? 0,
  }));
  const sum = (pick: (x: (typeof perRound)[number]) => number): number => perRound.reduce((a, x) => a + pick(x), 0);
  return {
    envelopes: sum((x) => x.envelopes),
    transactions: sum((x) => x.transactions),
    events: sum((x) => x.events),
    rejected: agentRounds.reduce((a, r) => a + (r.tracker?.rejected ?? 0), 0),
    perRound,
  };
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** The markdown the campaign prints: the two readings, and what they are not. */
export function coexistenceMarkdown(r: CoexistenceReading): string {
  const trackerVersion = r.comparison.version ?? "version unknown";
  const lines = [
    `### What it costs to live beside the tracker · ${r.config.rounds} rounds/side · ${r.config.rps} rps · ${r.config.measureSec}s measured`,
    "",
    `One thing different between the two sides: the tracker (\`${r.comparison.module}\`, @sentry/node ${trackerVersion}),`,
    "loaded beside the agent with `--import`, its `SENTRY_DSN` pointing at a local sink of this benchmark.",
    "Same reference app, same seeded load, alternating rounds on the same machine.",
    "",
  ];
  if (r.reason !== undefined) {
    lines.push(`**${r.reason}**`, "");
    return lines.join("\n");
  }
  lines.push(
    "The Δ below is what the tracker costs beside the agent. It is **not** the instrumentation's budget (invariant 3)",
    "and nothing here is a pass or a fail of it: the budget is what the `bench` campaign measures, the agent",
    "against no agent. What this run answers is the other half of the clause — the tracker's cost is reported,",
    "and whether it is attributed to the agent is the hook estimate below.",
    "",
    "| What the tracker costs | Agent alone | Beside the tracker | Δ | Noise | p | resolved? |",
    "|---|---:|---:|---:|---:|---:|:-:|",
  );
  for (const m of r.metrics) {
    const label =
      m.method === "pooled-p99" && m.samples !== undefined
        ? `${METRIC_LABEL[m.metric]} (${m.unit}, pooled n=${m.samples})`
        : `${METRIC_LABEL[m.metric]} (${m.unit}, median of rounds)`;
    const noise = m.noiseSource !== undefined ? `${m.noise} (${m.noiseSource})` : `${m.noise}`;
    lines.push(
      `| ${label} | ${m.baseline} | ${m.agent} | ${signed(m.delta)} | ${noise} | ${round(m.p, 4)} | ${m.resolved ? "yes" : "no"} |`,
    );
  }
  lines.push(
    "",
    "The agent's own estimate of its hooks (`agent.resources.hookMsPerRequest`, sampled inside `guard`, ADR 0080)",
    "— the number the budget of invariant 3 is about — in the two configurations:",
    hookLine(r),
    "",
    `The tracker shipped ${r.tracker.envelopes} envelope(s) (${r.tracker.transactions} transactions, ${r.tracker.events} events)`,
    "to its local sink across the rounds that loaded it: nothing of what it would send left this machine.",
  );
  const unresolved = r.metrics.filter((m) => !m.resolved).length + (r.hook.resolved ? 0 : 1);
  if (unresolved > 0) {
    lines.push(
      "",
      `${unresolved} of ${r.config.comparisons} could not be resolved here. More rounds or a quieter machine is the answer;`,
      "reading the numbers anyway is not.",
    );
  }
  lines.push("", "#### The per-round differences behind each row (tracker's side − agent's alone)", "");
  for (const m of r.metrics) {
    lines.push(`- ${METRIC_LABEL[m.metric]} (${m.unit}): ${m.differences.map((d) => signed(d)).join(", ")}`);
  }
  if (r.hook.differences.length > 0) {
    lines.push(`- hook estimate (ms/request): ${r.hook.differences.map((d) => signed(d)).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function hookLine(r: CoexistenceReading): string {
  const h = r.hook;
  const both = h.baseline !== undefined && h.agent !== undefined;
  const values = both
    ? `**${h.baseline}** ms of CPU per request with the agent alone, **${h.agent}** beside the tracker`
    : "not reported by every round";
  const decision =
    h.reason !== undefined
      ? `not compared — ${h.reason}`
      : `Paired round by round, p ${round(h.p ?? Number.NaN, 4)} — ${h.resolved ? "resolved" : "not resolved"}.`;
  return `${values}. ${decision} That it does not move is what «the tracker's cost is not attributed to it» says.`;
}
