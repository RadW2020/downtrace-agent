import { describe, expect, it } from "vitest";
import { COEXISTENCE, COMPARISONS, instrumentsOf, pgDepthOf, STEPS } from "../src/instruments-steps.ts";

/**
 * `bench-instruments` weighs one thing per step. If a step changed two things, the row would be the cost of both
 * and the table would say nothing about either (ADR 0027). The Postgres observer is weighed part by part with
 * `DOWNTRACE_PG_DEPTH` (gh-592): it enters at its shallowest and is deepened one level at a time, so each of its
 * rows is one part and the three add up to the observer. The last two steps weigh the two halves of the black
 * box with `DOWNTRACE_SHED`, on top of every observer (gh-570). The coexistence comparison weighs the tracker
 * loaded beside the whole agent (ESC-16, gh-615), and it holds the same one-thing rule.
 */
describe("the steps of bench-instruments", () => {
  it("are nine, and the first weighs the agent against nothing", () => {
    expect(STEPS.length).toBe(9);
    expect(STEPS[0]?.from).toBeUndefined();
    expect(instrumentsOf(STEPS[0]?.to ?? {})).toEqual(new Set());
  });

  it("each adds exactly one observer, holds exactly one more seam shut, loads the tracker, or deepens the pg observer by one level", () => {
    for (const step of COMPARISONS.slice(1)) {
      const from = step.from ?? {};
      const added = [...instrumentsOf(step.to)].filter((i) => !instrumentsOf(from).has(i));
      const removed = [...instrumentsOf(from)].filter((i) => !instrumentsOf(step.to).has(i));
      const shedChanged = (from.DOWNTRACE_SHED ?? "nothing") !== (step.to.DOWNTRACE_SHED ?? "nothing");
      // The tracker is one kind of thing a comparison can change (ESC-16): not an observer the agent switches
      // on, not a seam the agent holds shut, but a second instrumentation loaded beside the agent.
      const trackerLoaded = step.tracker === true;
      // The Postgres observer is a second (gh-592): it enters together with its depth as one thing — the
      // observer and how shallow it is are the row — and afterwards only its depth changes, one level at a
      // time. Entering at full depth would be the observer alone, the way the other observers enter.
      const depthFrom = pgDepthOf(from);
      const depthTo = pgDepthOf(step.to);
      const pgEnteringAtADepth = added.includes("pg") && depthTo !== "full";
      const deepened = !pgEnteringAtADepth && depthFrom !== depthTo;
      expect(removed, step.name).toEqual([]);
      expect(
        added.length -
          (pgEnteringAtADepth ? 1 : 0) +
          (pgEnteringAtADepth || deepened ? 1 : 0) +
          (shedChanged ? 1 : 0) +
          (trackerLoaded ? 1 : 0),
        `${step.name} changes exactly one thing`,
      ).toBe(1);
    }
  });

  it("weighs the tracker on top of the whole agent, with the agent on both sides", () => {
    const full = new Set(["runtime", "pg", "http", "redis"]);
    expect(instrumentsOf(COEXISTENCE.from ?? {}), "the baseline side runs the whole agent").toEqual(full);
    expect(instrumentsOf(COEXISTENCE.to), "the agent side runs the whole agent").toEqual(full);
    expect(COEXISTENCE.from, "the environments are the same; the tracker is the only difference").toEqual(
      COEXISTENCE.to,
    );
    expect(COEXISTENCE.tracker, "the tracker is what the agent side adds").toBe(true);
  });

  it("each step starts where the previous one ended, so the rows add up to the whole agent", () => {
    // The observer chain: the agent, the four observers — the Postgres one in its three depths — and nothing else.
    for (let i = 1; i < 7; i++) {
      expect(STEPS[i]?.from, STEPS[i]?.name).toEqual(STEPS[i - 1]?.to);
    }
  });

  it("weighs the Postgres observer part by part, shallow to deep, so its three rows add up to the observer", () => {
    const [wrapper, context, text] = STEPS.slice(2, 5);
    // The observer enters at its floor and ends at the full observer the variable does not name.
    expect(instrumentsOf(wrapper?.to ?? {}), "the wrapper step turns the observer on").toEqual(
      new Set(["runtime", "pg"]),
    );
    expect(pgDepthOf(wrapper?.to ?? {}), "the observer enters at its shallowest").toBe("wrapper");
    expect(pgDepthOf(context?.from ?? {}), "the context step starts where the wrapper step ended").toBe("wrapper");
    expect(pgDepthOf(context?.to ?? {}), "the context step deepens by one level").toBe("context");
    expect(pgDepthOf(text?.from ?? {}), "the text step starts where the context step ended").toBe("context");
    expect(pgDepthOf(text?.to ?? {}), "the text step ends at the observer as it is").toBe("full");
    expect(text?.to, "the full observer is the absence of the variable").not.toHaveProperty("DOWNTRACE_PG_DEPTH");
    // What the three rows charge: the wrapper, then the attribution of calls and waits, then the fingerprint of
    // the text. Nothing of the other observers moves between them.
    for (const step of [wrapper, context, text]) {
      expect(instrumentsOf(step?.to ?? {}), step?.name).toEqual(new Set(["runtime", "pg"]));
    }
  });

  it("weighs the black box with everything on: the seams are held shut on top of every observer", () => {
    for (const step of STEPS.slice(7)) {
      expect(instrumentsOf(step.to), step.name).toEqual(new Set(["runtime", "pg", "http", "redis"]));
      expect(step.to.DOWNTRACE_SHED).toBeDefined();
      expect(step.from?.DOWNTRACE_SHED).toBeDefined();
    }
    // Held shut is the baseline of each of those pairs: the cost comes out positive when the seam costs something.
    expect(STEPS[7]?.from?.DOWNTRACE_SHED).toBe("fine");
    expect(STEPS[7]?.to.DOWNTRACE_SHED).toBe("nothing");
    expect(STEPS[8]?.from?.DOWNTRACE_SHED).toBe("profile");
    expect(STEPS[8]?.to.DOWNTRACE_SHED).toBe("fine");
  });
});
