import { dependencyKey } from "./context.ts";
import type { FineRequest, FineSnapshot } from "./fine.ts";
import type { PendingCapture } from "./transport.ts";

/**
 * The captures this process has been asked for, and where each one is.
 *
 * The order arrives in the answer to a batch (ADR 0071), observation starts here, the start is reported in
 * the next batch (ADR 0098) and the evidence goes out when the window closes (ADR 0073). This holds the
 * bookkeeping between those four moments and nothing else: it does not talk to the network and it does not
 * read the clock on its own, so a test can drive both (gh-379).
 *
 * **Every instance obeys.** The same answer reaches all of them, and none can know what the others are
 * doing without a coordination this instrumentation deliberately does not have. Observing costs nothing —
 * the fine register is always on (ADR 0067/0068) — and the only thing that costs is the upload, which the
 * cloud settles by itself: the first evidence ends the capture and the rest get a 409.
 */

/** How many captures may be watched at once. Bounded like everything else the agent holds. */
export const MAX_LIVE_CAPTURES = 4;

/**
 * What the order says to watch. A route, a dependency, or neither — and never both, because a capture is
 * about one thing (`PendingCapture` in the response contract).
 */
export interface CaptureFootprint {
  environment?: string;
  method?: string;
  route?: string;
  kind?: string;
  target?: string;
}

export interface LiveCapture {
  id: string;
  /** The effective start of observation: when this process began watching, not when it was accepted. */
  startedAt: number;
  /** When the window closes, in the same clock as `startedAt`. */
  endsAt: number;
  /** Reported to the cloud already, so the next batch does not say it twice. */
  reported: boolean;
  /** What the cloud asked to watch. What the evidence is filtered by (gh-397). */
  footprint: CaptureFootprint;
}

/** What the next batch says about the captures under way. */
export interface CaptureReport {
  id: string;
  startedAt: number;
}

export class Captures {
  private readonly live = new Map<string, LiveCapture>();

  get size(): number {
    return this.live.size;
  }

  /**
   * Takes the orders that can be obeyed and starts watching them.
   *
   * An order already under way is not started twice — the answer repeats it until the cloud sees the start.
   * One whose deadline has passed is not started at all: the cloud has stopped waiting, and evidence for it
   * would arrive to a capture that is already closed.
   */
  accept(pending: PendingCapture[], now: number): void {
    for (const order of pending) {
      if (this.live.size >= MAX_LIVE_CAPTURES) return;
      if (this.live.has(order.id)) continue;
      if (order.expiresAt <= now) continue;
      const footprint: CaptureFootprint = {};
      if (order.environment !== undefined) footprint.environment = order.environment;
      if (order.method !== undefined) footprint.method = order.method;
      if (order.route !== undefined) footprint.route = order.route;
      if (order.kind !== undefined) footprint.kind = order.kind;
      if (order.target !== undefined) footprint.target = order.target;
      this.live.set(order.id, {
        id: order.id,
        startedAt: now,
        endsAt: now + order.windowSeconds * 1000,
        reported: false,
        footprint,
      });
    }
  }

  /** The starts the next batch has to carry, each said once. */
  toReport(): CaptureReport[] {
    const out: CaptureReport[] = [];
    for (const c of this.live.values()) {
      if (c.reported) continue;
      out.push({ id: c.id, startedAt: c.startedAt });
    }
    return out;
  }

  /** Marks as said what the batch actually carried, and only after it landed. */
  reported(ids: string[]): void {
    for (const id of ids) {
      const c = this.live.get(id);
      if (c) c.reported = true;
    }
  }

  /** The captures whose window has closed. Taking them removes them: evidence is sent once. */
  take(now: number): LiveCapture[] {
    const done: LiveCapture[] = [];
    for (const c of this.live.values()) {
      if (c.endsAt <= now) done.push(c);
    }
    for (const c of done) this.live.delete(c.id);
    return done;
  }

  /** Everything still under way, for the process that is leaving: partial evidence beats silence. */
  takeAll(): LiveCapture[] {
    const all = [...this.live.values()];
    this.live.clear();
    return all;
  }
}

/**
 * What one capture saw, out of everything the black box holds.
 *
 * `product.md:192` asks for **both** coverages and never their total: what was observed from the effective
 * start, and what was attached from detail that was already being kept. A single number would hide that half
 * of it is older than the capture.
 */
/**
 * What an armed route kept for itself, if this capture is about one. `armedAt` is when its arm began, which is
 * the instant from which the reserve —and not the shared ring— is what this route's detail comes from.
 */
export interface PrearmReserve {
  armedAt: number;
  requests: FineRequest[];
}

export interface CaptureSlice {
  requests: FineRequest[];
  observedRequests: number;
  attachedRequests: number;
  detailLost: number;
  truncated: number;
}

/**
 * `nameOf` is how a route is called outside this process: itself, or a digest of itself in minimal mode.
 * The order comes from the cloud, which only ever knew the outside name, so the comparison happens there
 * and not against what the register keeps (gh-395).
 *
 * `prearm` is **required**, and `null` is how a caller says there is no reserve. It was optional, and the one
 * caller in production simply never passed it: the reserve filled up for an armed route and nothing ever read
 * it, with a green test on each half and the wire between them cut (gh-498). An optional argument is an
 * invitation to forget; a required one makes the compiler ask.
 */
export function sliceFor(
  capture: LiveCapture,
  snapshot: FineSnapshot,
  nameOf: (route: string) => string,
  prearm: PrearmReserve | null,
): CaptureSlice {
  const keep = matcher(capture.footprint, nameOf);
  // Where the two registers meet. A route armed before this capture kept its own requests from `armedAt` on,
  // and those are the authority for that window: the global ring may have lost them to other routes' traffic,
  // and the reserve cannot (ADR 0122). Before `armedAt` there is only the ring, as always. A boundary in time
  // rather than a comparison of fields: nothing has to guess whether two rows are the same request.
  const armedAt = prearm?.armedAt ?? Number.POSITIVE_INFINITY;
  let observed = 0;
  let attached = 0;
  let detailLost = 0;
  let truncated = 0;
  const requests: FineRequest[] = [];
  const count = (r: FineRequest) => {
    if (r.startedAt >= capture.startedAt) observed++;
    else attached++;
    if (r.detailLost) detailLost++;
    if (r.truncated) truncated++;
  };
  for (const r of snapshot.requests) {
    if (!keep(r)) continue;
    if (r.startedAt >= armedAt) continue;
    requests.push(r);
    count(r);
  }
  for (const r of prearm?.requests ?? []) {
    if (!keep(r)) continue;
    requests.push(r);
    count(r);
  }
  requests.sort((a, b) => a.startedAt - b.startedAt);
  return { requests, observedRequests: observed, attachedRequests: attached, detailLost, truncated };
}

/**
 * What the order asked for, as a question about one request.
 *
 * A capture of a route is the common case and matches on the template, and on the method when the order
 * names one. A capture of a dependency matches on the label the register kept for each request. And an
 * order that names neither — an environment on its own — is what it has always been: everything.
 *
 * A request whose dependency list did not fit **matches anyway**: what the register has is incomplete, and
 * reading a gap as proof that the dependency was not used is the mistake invariant 14 is about.
 */
function matcher(footprint: CaptureFootprint, nameOf: (route: string) => string): (r: FineRequest) => boolean {
  const { method, route, kind, target } = footprint;
  if (route !== undefined && route !== "") {
    return (r) => nameOf(r.route) === route && (method === undefined || method === "" || r.method === method);
  }
  if ((kind !== undefined && kind !== "") || (target !== undefined && target !== "")) {
    const label = dependencyKey(kind ?? "", target ?? "");
    return (r) => r.dependenciesTruncated === true || r.dependencies.includes(label);
  }
  return () => true;
}
