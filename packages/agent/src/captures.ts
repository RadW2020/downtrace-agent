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

export interface LiveCapture {
  id: string;
  /** The effective start of observation: when this process began watching, not when it was accepted. */
  startedAt: number;
  /** When the window closes, in the same clock as `startedAt`. */
  endsAt: number;
  /** Reported to the cloud already, so the next batch does not say it twice. */
  reported: boolean;
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
      this.live.set(order.id, {
        id: order.id,
        startedAt: now,
        endsAt: now + order.windowSeconds * 1000,
        reported: false,
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
export interface CaptureSlice {
  requests: FineRequest[];
  observedRequests: number;
  attachedRequests: number;
  detailLost: number;
  truncated: number;
}

export function sliceFor(capture: LiveCapture, snapshot: FineSnapshot): CaptureSlice {
  let observed = 0;
  let attached = 0;
  for (const r of snapshot.requests) {
    if (r.startedAt >= capture.startedAt) observed++;
    else attached++;
  }
  return {
    requests: snapshot.requests,
    observedRequests: observed,
    attachedRequests: attached,
    detailLost: snapshot.coverage.detailLost,
    truncated: snapshot.coverage.truncated,
  };
}
