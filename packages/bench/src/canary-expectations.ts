import type { Regression } from "@downtrace/reference-app";

/**
 * What a finding looks like in `GET /api/p/{slug}/findings`, as far as the canary reads it.
 */
export interface FindingSummary {
  id: number;
  state: string;
  trigger: string;
  scope: string;
  endpoint: { method: string; route: string } | null;
  dependency: { kind: string; target: string } | null;
  since: string;
}

/**
 * The finding a regression of the reference app should cause in production: which triggers may open it, where
 * it is (a route, or a dependency of the project as a whole), and which patterns its report may recognise. The
 * names are the cloud's own — the detector's triggers and the report's catalogue of patterns.
 *
 * `n_plus_one` is the shape the end-to-end walk of a real regression already proves in CI. The other four are
 * read off the detector — one trigger each, the reference app was built that way — and the canary's nights are
 * what confirm them: a red night says which finding came instead, and then either the detector or this table is
 * wrong, and the ticket it opens is where that is decided. A list of two means the evidence can honestly take
 * either shape, not that the canary is lenient.
 */
export interface Expectation {
  /**
   * What the canary switches on for the night, and with which parameters: the regression itself, and whatever it
   * needs to show at all. Switching off gives every one of them back the parameters it had.
   */
  switches: Readonly<Partial<Record<Regression, { params?: Readonly<Record<string, number>> }>>>;
  triggers: readonly string[];
  /** Route findings, as method and template. */
  routes: readonly { method: string; route: string }[];
  /** Dependency findings, by kind: a saturated pool is a claim about Postgres, not about one route. */
  dependencyKinds: readonly string[];
  patterns: readonly string[];
}

const checkout = { method: "POST", route: "/checkout" } as const;

export const EXPECTATIONS: Readonly<Record<Regression, Expectation>> = {
  // Checkout runs four queries per line instead of three for the whole order.
  n_plus_one: {
    switches: { n_plus_one: {} },
    triggers: ["composition_shift"],
    routes: [checkout],
    dependencyKinds: [],
    patterns: ["operation-multiplication"],
  },
  // The provider answers seconds later, inside the checkout's transaction.
  slow_dependency: {
    switches: { slow_dependency: {} },
    triggers: ["dependency_degraded", "latency_shift"],
    routes: [checkout],
    dependencyKinds: ["http"],
    patterns: ["dependency-degradation"],
  },
  // Provider calls with a short timeout, retried without backoff: more calls per checkout, and failing ones. It
  // only retries what fails, and the provider answers at once unless it is slowed, so the night slows it past the
  // timeout, as the reference app's own test of it does.
  aggressive_retries: {
    switches: { aggressive_retries: {}, slow_dependency: { params: { delayMs: 1000 } } },
    triggers: ["composition_shift", "dependency_degraded"],
    routes: [checkout],
    dependencyKinds: ["http"],
    patterns: ["operation-multiplication", "dependency-degradation"],
  },
  // A fraction of checkouts never returns its connection to the pool.
  pool_leak: {
    switches: { pool_leak: {} },
    triggers: ["pool_saturation"],
    routes: [],
    dependencyKinds: ["postgres"],
    patterns: ["saturation"],
  },
  // A fraction of product reads throws an error the route never threw before.
  new_error: {
    switches: { new_error: {} },
    triggers: ["new_error"],
    routes: [{ method: "GET", route: "/products/:id" }],
    dependencyKinds: [],
    patterns: ["new-error"],
  },
};

/** Whether an open finding is the one the expectation names. */
export function matches(finding: FindingSummary, expectation: Expectation): boolean {
  if (finding.state !== "open") return false;
  if (!expectation.triggers.includes(finding.trigger)) return false;
  const { endpoint, dependency } = finding;
  const onRoute =
    endpoint !== null && expectation.routes.some((r) => r.method === endpoint.method && r.route === endpoint.route);
  const onDependency = dependency !== null && expectation.dependencyKinds.includes(dependency.kind);
  return onRoute || onDependency;
}

const DAY_MS = 86_400_000;

/**
 * Tonight's regression: one per UTC day, in the order of the table, so five consecutive nights check all five and
 * a night retried the same day measures the same one. The rotation lives with the list it rotates.
 */
export function regressionFor(day: Date): Regression {
  const names = Object.keys(EXPECTATIONS) as Regression[];
  const index = Math.floor(day.getTime() / DAY_MS) % names.length;
  // biome-ignore lint/style/noNonNullAssertion: the index is taken modulo the length of a list that is never empty.
  return names[index]!;
}
