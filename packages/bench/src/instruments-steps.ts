/**
 * The head-to-head comparisons `bench-instruments` makes, in order. Each step adds one thing to the step before
 * it, so the difference is that thing's own cost: first the observers, one at a time (ADR 0027), then the two
 * halves of the black box that `DOWNTRACE_SHED` can hold shut — the fine detail and the profile (ADR 0080,
 * gh-570). Beside the steps lives the coexistence comparison (ESC-16, gh-615): the whole agent against the
 * whole agent with the tracker loaded beside it. A module of its own so a test can enumerate every comparison
 * and check that each one differs from its own baseline in exactly one thing.
 */
export interface InstrumentStep {
  name: string;
  /** Environment of the baseline side; `undefined` is no agent at all. */
  from: Readonly<Record<string, string>> | undefined;
  /** Environment of the agent side. */
  to: Readonly<Record<string, string>>;
  /**
   * Whether the agent side loads the error tracker beside the agent (ESC-16): its entry point with `--import`,
   * and a `SENTRY_DSN` pointing at the campaign's local tracker sink. The module and the DSN are the two faces
   * of one thing — the app refuses to start with a DSN and no tracker, and with a tracker and no DSN the
   * tracker does nothing — so this step carries them as one, and the test counts them as one.
   */
  tracker?: boolean | undefined;
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

/**
 * The coexistence comparison (ESC-16, gh-615): the whole agent against the whole agent with the tracker loaded
 * beside it, so the difference is the tracker's own cost. Not one of the steps above: the steps answer «which
 * observer to pay for», share one gate among themselves (ADR 0027) and make their claim against the budget,
 * while this one answers «what the tracker costs beside us», reads the agent's own estimate in both
 * configurations, and reports its Δ without a verdict of the budget — the Δ is the tracker's cost, and the
 * budget is the `bench` campaign's.
 */
export const COEXISTENCE: InstrumentStep = {
  name: "the tracker beside the agent",
  from: { DOWNTRACE_INSTRUMENT: ALL },
  to: { DOWNTRACE_INSTRUMENT: ALL },
  // The tracker's own `SENTRY_DSN` is not here on purpose: it points at a local sink on a port that only exists
  // once the round is up, so it is handed to the process at start-up, the way the batch sink's `DOWNTRACE_URL` is.
  tracker: true,
};

/** Every comparison weighed one thing at a time; a test that says «all» enumerates this, from the source (ADR 0091). */
export const COMPARISONS: readonly InstrumentStep[] = [...STEPS, COEXISTENCE];

/** The observers an environment switches on, as a set, so two environments can be compared by what differs. */
export function instrumentsOf(env: Readonly<Record<string, string>>): ReadonlySet<string> {
  const raw = env.DOWNTRACE_INSTRUMENT ?? "all";
  if (raw === "none") return new Set();
  if (raw === "all") return new Set(ALL.split(","));
  return new Set(raw.split(",").map((s) => s.trim()));
}
