import type { Regression } from "@downtrace/reference-app";
import { EXPECTATIONS, type FindingSummary, matches } from "./canary-expectations.ts";

/**
 * One night of the canary: switch one regression on in a reference app that reports to a running cloud, wait until
 * the cloud opens the finding that regression should cause, read the pattern its report recognises, switch the
 * regression off and wait until the cloud observes the recovery. It runs against what is deployed — the cloud, the
 * detector's real windows and its real rule — which is the part no test in CI reaches.
 *
 * Three outcomes, and they are not two: `pass`, `fail` (the cloud answered, and its answer is not the expected
 * one), and `unmeasurable` (the reference app or the cloud did not answer, the project's data was not arriving, or
 * the night started dirty). A negative answer is only claimed over a wait the canary saw whole: one moment of the
 * wait in which the cloud did not answer, or the data had stopped arriving, makes "nothing opened" and "nothing
 * recovered" unmeasurable, because no data is not no errors.
 *
 * The regression is switched off on every path, in a `finally`, retried; when even that fails, the outcome is
 * `fail` and the reason says it first, because the reference app then stays degraded until someone acts.
 */

export type Outcome = "pass" | "fail" | "unmeasurable";

export interface CanaryConfig {
  /** Base URL of the reference app, whose `/__admin/regressions` the canary switches. */
  appUrl: string;
  /** Base URL of the cloud the reference app reports to. */
  cloudUrl: string;
  project: string;
  /** An access credential of the project, level `read`. */
  token: string;
  /** What the reference app's `/__admin` asks for (its ADMIN_TOKEN); empty when it asks for nothing. */
  appToken: string;
  pollMs: number;
  detectWithinMs: number;
  recoverWithinMs: number;
  requestTimeoutMs: number;
  /** How recent the project's last batch has to be for a moment of the night to count as seen. */
  freshWithinMs: number;
}

export interface CanaryDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface CycleResult {
  regression: Regression;
  outcome: Outcome;
  /** One sentence: what decided the outcome. */
  reason: string;
  startedAt: string;
  endedAt: string;
  enabledAt: string | null;
  detectedAt: string | null;
  disabledAt: string | null;
  recoveredAt: string | null;
  minutesToDetect: number | null;
  minutesToRecover: number | null;
  finding: (FindingSummary & { report: string; pattern: string | null }) | null;
  /** Findings that opened during the night and are not the expected one. */
  openedInstead: FindingSummary[];
  lastVerification: { conclusion: string; because?: string } | null;
  /** False only when the canary could not switch the regression off: the reference app stays degraded. */
  switchedOff: boolean;
}

/** How many times switching off is tried, and how long apart: a regression left on costs the next nights. */
const SWITCH_OFF_ATTEMPTS = 3;
const SWITCH_OFF_RETRY_MS = 10_000;

// Fields and not parameter properties: Node runs this file by stripping its types, and a parameter property is not
// a type to strip.
class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} from ${url}`);
    this.url = url;
    this.status = status;
  }
}

/** What the reference app says about one regression. */
interface RegressionState {
  enabled: boolean;
  params: Record<string, number>;
}

export async function runCycle(regression: Regression, config: CanaryConfig, deps: CanaryDeps): Promise<CycleResult> {
  const expectation = EXPECTATIONS[regression];
  const minutes = (ms: number) => Math.round(ms / 60_000);
  const at = (ms: number) => new Date(ms).toISOString();
  const result: CycleResult = {
    regression,
    outcome: "unmeasurable",
    reason: "",
    startedAt: deps.now().toISOString(),
    endedAt: "",
    enabledAt: null,
    detectedAt: null,
    disabledAt: null,
    recoveredAt: null,
    minutesToDetect: null,
    minutesToRecover: null,
    finding: null,
    openedInstead: [],
    lastVerification: null,
    switchedOff: true,
  };
  const done = (outcome: Outcome, reason: string): CycleResult => {
    result.outcome = outcome;
    result.reason = reason;
    result.endedAt = deps.now().toISOString();
    return result;
  };

  const request = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(config.requestTimeoutMs) });
    if (!res.ok) throw new HttpError(url, res.status);
    return (await res.json()) as unknown;
  };
  const regressionsUrl = `${config.appUrl}/__admin/regressions`;
  const appAuth: Record<string, string> = config.appToken ? { authorization: `Bearer ${config.appToken}` } : {};
  const put = (patch: Record<string, unknown>) =>
    request(regressionsUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", ...appAuth },
      body: JSON.stringify(patch),
    });
  const project = `${config.cloudUrl}/api/p/${encodeURIComponent(config.project)}`;
  const fromCloud = (path: string) =>
    request(`${project}${path}`, { headers: { authorization: `Bearer ${config.token}` } });

  /** Whether the project's data is arriving: its last batch within `freshWithinMs`, and when that was. */
  const freshness = async (): Promise<{ fresh: boolean; last: string | null }> => {
    const last = lastReceivedAtOf(await fromCloud("/status"));
    const fresh = last !== null && deps.now().getTime() - Date.parse(last) <= config.freshWithinMs;
    return { fresh, last };
  };

  // What the canary switches on (`expectation.switches`) and what it gives back when it switches off: the
  // parameters it found, so a night that needs a slower provider leaves the next night's as it was.
  const switched = Object.keys(expectation.switches) as Regression[];
  let found: Record<string, RegressionState> = {};
  let switchedOn = false;
  let switchedOffOnPurpose = false;
  const switchOff = async (): Promise<void> => {
    const patch = Object.fromEntries(
      switched.map((name) => [name, { enabled: false, params: found[name]?.params ?? {} }]),
    );
    for (let attempt = 1; ; attempt++) {
      try {
        await put(patch);
        return;
      } catch (err) {
        if (attempt >= SWITCH_OFF_ATTEMPTS) throw err;
        await deps.sleep(SWITCH_OFF_RETRY_MS);
      }
    }
  };

  try {
    // The reference app: it answers, and nothing is switched on. A regression left on by an earlier night is in
    // tonight's reference window, so the night measures nothing; it is switched off for tomorrow's.
    try {
      found = regressionStateOf(await request(regressionsUrl, { headers: appAuth }));
    } catch (err) {
      return done("unmeasurable", `the reference app did not answer: ${describe(err)}`);
    }
    const alreadyOn = Object.keys(found).filter((name) => found[name]?.enabled);
    if (alreadyOn.length > 0) {
      try {
        await put(Object.fromEntries(alreadyOn.map((name) => [name, { enabled: false }])));
      } catch (err) {
        result.switchedOff = false;
        return done(
          "fail",
          `could not switch off ${alreadyOn.join(", ")}, found on before the night began, so the reference app stays degraded: ${describe(err)}`,
        );
      }
      return done(
        "unmeasurable",
        `found ${alreadyOn.join(", ")} already on and switched it off: tonight's reference window saw it, so tonight measures nothing`,
      );
    }

    // The cloud: it answers, the project's data is arriving, and no finding like the expected one is open already
    // — the canary could not tell a new one from it.
    let preexisting: Set<number>;
    try {
      const { fresh, last } = await freshness();
      if (!fresh) {
        return done(
          "unmeasurable",
          `nothing of project ${config.project} has arrived in the last ${minutes(config.freshWithinMs)} min (last: ${last ?? "never"}): no data is not no errors`,
        );
      }
      const open = findingsOf(await fromCloud("/findings")).filter((f) => f.state === "open");
      const like = open.find((f) => matches(f, expectation));
      if (like !== undefined) {
        return done(
          "unmeasurable",
          `a finding like the expected one is already open (#${like.id}, ${like.trigger}, since ${like.since}): tonight could not tell a new one from it`,
        );
      }
      preexisting = new Set(open.map((f) => f.id));
    } catch (err) {
      return done("unmeasurable", `the cloud did not answer: ${describe(err)}`);
    }

    try {
      switchedOn = true;
      await put(
        Object.fromEntries(
          switched.map((name) => {
            const params = expectation.switches[name]?.params;
            return [name, params ? { enabled: true, params } : { enabled: true }];
          }),
        ),
      );
    } catch (err) {
      return done("unmeasurable", `the reference app did not switch ${switched.join(" and ")} on: ${describe(err)}`);
    }
    const enabledAt = deps.now().getTime();
    result.enabledAt = at(enabledAt);

    // The first moment of the night the canary did not see: the cloud not answering, or the data not arriving.
    let blind: string | undefined;
    const notSeen = (why: string) => {
      blind ??= why;
    };

    // Detection: the first open finding the canary did not see before, that the expectation names.
    let finding: FindingSummary | undefined;
    while (finding === undefined && deps.now().getTime() < enabledAt + config.detectWithinMs) {
      await deps.sleep(config.pollMs);
      try {
        const { fresh, last } = await freshness();
        if (!fresh) notSeen(`the project's data stopped arriving (last at ${last ?? "never"})`);
        const unseen = findingsOf(await fromCloud("/findings")).filter(
          (f) => f.state === "open" && !preexisting.has(f.id),
        );
        finding = unseen.find((f) => matches(f, expectation));
        result.openedInstead = unseen.filter((f) => f !== finding);
      } catch (err) {
        notSeen(`the cloud did not answer at ${deps.now().toISOString()}: ${describe(err)}`);
      }
    }
    if (finding === undefined) {
      if (blind !== undefined) {
        return done("unmeasurable", `no expected finding opened, but the canary did not see the whole wait: ${blind}`);
      }
      const instead = result.openedInstead.length
        ? `opened instead: ${result.openedInstead.map(describeFinding).join("; ")}`
        : "nothing else opened";
      return done(
        "fail",
        `no ${expectation.triggers.join(" or ")} finding on ${describeWhere(regression)} opened within ${minutes(config.detectWithinMs)} min of switching ${switched.join(" and ")} on; ${instead}`,
      );
    }
    const detectedAt = deps.now().getTime();
    result.detectedAt = at(detectedAt);
    result.minutesToDetect = minutes(detectedAt - enabledAt);

    const reportPath = `/findings/${finding.id}/report`;
    let pattern: string | null;
    try {
      pattern = patternOf(await fromCloud(reportPath));
    } catch (err) {
      return done("unmeasurable", `the cloud did not answer for the report of #${finding.id}: ${describe(err)}`);
    }
    result.finding = { ...finding, report: `${project}${reportPath}`, pattern };
    if (pattern === null || !expectation.patterns.includes(pattern)) {
      return done(
        "fail",
        `finding #${finding.id} opened, but its report recognises ${pattern ?? "no pattern"} where ${expectation.patterns.join(" or ")} was expected`,
      );
    }

    // Recovery: what the cloud observes since the regression went off.
    try {
      await switchOff();
      switchedOffOnPurpose = true;
    } catch (err) {
      result.switchedOff = false;
      return done("fail", `could not switch ${regression} off, so the reference app stays degraded: ${describe(err)}`);
    }
    const disabledAt = deps.now().getTime();
    result.disabledAt = at(disabledAt);
    const verificationPath = `/findings/${finding.id}/verification?since=${encodeURIComponent(result.disabledAt)}`;
    blind = undefined;
    while (deps.now().getTime() < disabledAt + config.recoverWithinMs) {
      await deps.sleep(config.pollMs);
      try {
        const { fresh, last } = await freshness();
        if (!fresh) notSeen(`the project's data stopped arriving (last at ${last ?? "never"})`);
        const v = verificationOf(await fromCloud(verificationPath));
        result.lastVerification = { conclusion: v.conclusion, ...(v.because ? { because: v.because } : {}) };
        if (v.conclusion === "recovery-observed") {
          const recoveredAt = deps.now().getTime();
          result.recoveredAt = at(recoveredAt);
          result.minutesToRecover = minutes(recoveredAt - disabledAt);
          return done(
            "pass",
            `finding #${finding.id} (${finding.trigger}, ${pattern}) opened ${result.minutesToDetect} min after switching ${switched.join(" and ")} on, and the recovery was observed ${result.minutesToRecover} min after switching it off`,
          );
        }
        if (v.conclusion === "inconclusive" && !v.waitingCouldHelp) {
          return done(
            "fail",
            `the verification of #${finding.id} is inconclusive and waiting could not help: ${v.because ?? "it gives no reason"}`,
          );
        }
      } catch (err) {
        notSeen(`the cloud did not answer at ${deps.now().toISOString()}: ${describe(err)}`);
      }
    }
    if (blind !== undefined) {
      return done("unmeasurable", `no recovery observed, but the canary did not see the whole wait: ${blind}`);
    }
    return done(
      "fail",
      `no recovery observed within ${minutes(config.recoverWithinMs)} min of switching ${regression} off: the verification of #${finding.id} still says ${result.lastVerification?.conclusion ?? "nothing"}`,
    );
  } catch (err) {
    // Something of the canary's own — its clock, its sleep — and not an answer from either side.
    return done("unmeasurable", `the canary itself failed: ${describe(err)}`);
  } finally {
    if (switchedOn && !switchedOffOnPurpose && result.switchedOff) {
      try {
        await switchOff();
      } catch (err) {
        result.switchedOff = false;
        result.outcome = "fail";
        result.reason = `could not switch ${regression} off, so the reference app stays degraded (${describe(err)}); before that: ${result.reason}`;
      }
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  return String(err);
}

function describeFinding(f: FindingSummary): string {
  const where = f.endpoint ? `${f.endpoint.method} ${f.endpoint.route}` : f.dependency ? f.dependency.kind : f.scope;
  return `#${f.id} ${f.trigger} on ${where}`;
}

function describeWhere(regression: Regression): string {
  const e = EXPECTATIONS[regression];
  return [...e.routes.map((r) => `${r.method} ${r.route}`), ...e.dependencyKinds].join(" or ");
}

// What comes back from the reference app and the cloud is external input: read as `unknown`, and checked to the
// extent the canary depends on it. A shape the canary cannot read is the other side not answering as it should.

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function shapeError(what: string): Error {
  return new Error(`unexpected shape of ${what}`);
}

function regressionStateOf(body: unknown): Record<string, RegressionState> {
  if (!isRecord(body)) throw shapeError("the regressions state");
  const out: Record<string, RegressionState> = {};
  for (const [name, value] of Object.entries(body)) {
    if (!isRecord(value) || typeof value.enabled !== "boolean") throw shapeError(`regression ${name}`);
    const params: Record<string, number> = {};
    if (isRecord(value.params)) {
      for (const [key, v] of Object.entries(value.params)) if (typeof v === "number") params[key] = v;
    }
    out[name] = { enabled: value.enabled, params };
  }
  return out;
}

/** `freshness.lastReceivedAt` of the project's status: the one shape every read declares its freshness in. */
function lastReceivedAtOf(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.freshness) || !("lastReceivedAt" in body.freshness)) {
    throw shapeError("the project status's freshness");
  }
  const last = body.freshness.lastReceivedAt;
  if (last === null) return null;
  if (typeof last !== "string" || Number.isNaN(Date.parse(last))) throw shapeError("freshness.lastReceivedAt");
  return last;
}

function findingsOf(body: unknown): FindingSummary[] {
  if (!isRecord(body) || !Array.isArray(body.findings)) throw shapeError("the findings");
  return body.findings.map((f: unknown) => {
    if (!isRecord(f) || typeof f.id !== "number" || typeof f.state !== "string" || typeof f.trigger !== "string") {
      throw shapeError("a finding");
    }
    const endpoint =
      isRecord(f.endpoint) && typeof f.endpoint.method === "string" && typeof f.endpoint.route === "string"
        ? { method: f.endpoint.method, route: f.endpoint.route }
        : null;
    const dependency =
      isRecord(f.dependency) && typeof f.dependency.kind === "string" && typeof f.dependency.target === "string"
        ? { kind: f.dependency.kind, target: f.dependency.target }
        : null;
    return {
      id: f.id,
      state: f.state,
      trigger: f.trigger,
      scope: typeof f.scope === "string" ? f.scope : "",
      endpoint,
      dependency,
      since: typeof f.since === "string" ? f.since : "",
    };
  });
}

function patternOf(body: unknown): string | null {
  if (!isRecord(body)) throw shapeError("the report");
  if (body.pattern === null || body.pattern === undefined) return null;
  if (!isRecord(body.pattern) || typeof body.pattern.name !== "string") throw shapeError("the report's pattern");
  return body.pattern.name;
}

function verificationOf(body: unknown): { conclusion: string; because?: string; waitingCouldHelp: boolean } {
  if (!isRecord(body) || typeof body.conclusion !== "string") throw shapeError("the verification");
  return {
    conclusion: body.conclusion,
    ...(typeof body.because === "string" ? { because: body.because } : {}),
    waitingCouldHelp: body.waitingCouldHelp === true,
  };
}
