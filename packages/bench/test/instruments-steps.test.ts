import { describe, expect, it } from "vitest";
import { COEXISTENCE, COMPARISONS, instrumentsOf, STEPS } from "../src/instruments-steps.ts";

/**
 * `bench-instruments` weighs one thing per step. If a step changed two things, the row would be the cost of both
 * and the table would say nothing about either (ADR 0027). The last two steps weigh the two halves of the black
 * box with `DOWNTRACE_SHED`, on top of every observer (gh-570). The coexistence comparison weighs the tracker
 * loaded beside the whole agent (ESC-16, gh-615), and it holds the same one-thing rule.
 */
describe("the steps of bench-instruments", () => {
  it("are seven, and the first weighs the agent against nothing", () => {
    expect(STEPS.length).toBe(7);
    expect(STEPS[0]?.from).toBeUndefined();
    expect(instrumentsOf(STEPS[0]?.to ?? {})).toEqual(new Set());
  });

  it("each adds exactly one observer, holds exactly one more seam shut, or loads the tracker", () => {
    for (const step of COMPARISONS.slice(1)) {
      const from = step.from ?? {};
      const added = [...instrumentsOf(step.to)].filter((i) => !instrumentsOf(from).has(i));
      const removed = [...instrumentsOf(from)].filter((i) => !instrumentsOf(step.to).has(i));
      const shedChanged = (from.DOWNTRACE_SHED ?? "nothing") !== (step.to.DOWNTRACE_SHED ?? "nothing");
      // The tracker is the fourth kind of thing a comparison can change (ESC-16): not an observer the agent
      // switches on, not a seam the agent holds shut, but a second instrumentation loaded beside the agent.
      const trackerLoaded = step.tracker === true;
      expect(removed, step.name).toEqual([]);
      expect(
        added.length + (shedChanged ? 1 : 0) + (trackerLoaded ? 1 : 0),
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
    for (let i = 1; i < 5; i++) {
      expect(STEPS[i]?.from, STEPS[i]?.name).toEqual(STEPS[i - 1]?.to);
    }
  });

  it("weighs the black box with everything on: the seams are held shut on top of every observer", () => {
    for (const step of STEPS.slice(5)) {
      expect(instrumentsOf(step.to), step.name).toEqual(new Set(["runtime", "pg", "http", "redis"]));
      expect(step.to.DOWNTRACE_SHED).toBeDefined();
      expect(step.from?.DOWNTRACE_SHED).toBeDefined();
    }
    // Held shut is the baseline of each of those pairs: the cost comes out positive when the seam costs something.
    expect(STEPS[5]?.from?.DOWNTRACE_SHED).toBe("fine");
    expect(STEPS[5]?.to.DOWNTRACE_SHED).toBe("nothing");
    expect(STEPS[6]?.from?.DOWNTRACE_SHED).toBe("profile");
    expect(STEPS[6]?.to.DOWNTRACE_SHED).toBe("fine");
  });
});
