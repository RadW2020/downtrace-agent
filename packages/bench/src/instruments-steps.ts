/**
 * The head-to-head comparisons `bench-instruments` makes, in order. Each step adds one thing to the step before
 * it, so the difference is that thing's own cost: first the observers, one at a time (ADR 0027), then the two
 * halves of the black box that `DOWNTRACE_SHED` can hold shut — the fine detail and the profile (ADR 0080,
 * gh-570). A module of its own so a test can enumerate the steps and check that each one differs from its own
 * baseline in exactly one thing.
 */
export interface InstrumentStep {
  name: string;
  /** Environment of the baseline side; `undefined` is no agent at all. */
  from: Readonly<Record<string, string>> | undefined;
  /** Environment of the agent side. */
  to: Readonly<Record<string, string>>;
}

const ALL = "runtime,pg,http,redis";

export const STEPS: readonly InstrumentStep[] = [
  { name: "the agent itself", from: undefined, to: { DOWNTRACE_INSTRUMENT: "none" } },
  { name: "runtime health", from: { DOWNTRACE_INSTRUMENT: "none" }, to: { DOWNTRACE_INSTRUMENT: "runtime" } },
  { name: "postgres", from: { DOWNTRACE_INSTRUMENT: "runtime" }, to: { DOWNTRACE_INSTRUMENT: "runtime,pg" } },
  {
    name: "outgoing HTTP",
    from: { DOWNTRACE_INSTRUMENT: "runtime,pg" },
    to: { DOWNTRACE_INSTRUMENT: "runtime,pg,http" },
  },
  { name: "redis", from: { DOWNTRACE_INSTRUMENT: "runtime,pg,http" }, to: { DOWNTRACE_INSTRUMENT: ALL } },
  // The black box, weighed on top of every observer: with the fine detail held shut against with it kept, and
  // with the profile held shut too against only the fine detail shut.
  {
    name: "the fine detail",
    from: { DOWNTRACE_INSTRUMENT: ALL, DOWNTRACE_SHED: "fine" },
    to: { DOWNTRACE_INSTRUMENT: ALL, DOWNTRACE_SHED: "nothing" },
  },
  {
    name: "the profile",
    from: { DOWNTRACE_INSTRUMENT: ALL, DOWNTRACE_SHED: "profile" },
    to: { DOWNTRACE_INSTRUMENT: ALL, DOWNTRACE_SHED: "fine" },
  },
];

/** The observers an environment switches on, as a set, so two environments can be compared by what differs. */
export function instrumentsOf(env: Readonly<Record<string, string>>): ReadonlySet<string> {
  const raw = env.DOWNTRACE_INSTRUMENT ?? "all";
  if (raw === "none") return new Set();
  if (raw === "all") return new Set(ALL.split(","));
  return new Set(raw.split(",").map((s) => s.trim()));
}
