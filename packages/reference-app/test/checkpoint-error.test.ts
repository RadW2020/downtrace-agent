import { describe, expect, it } from "vitest";
import { CheckpointError, checkpointError } from "../src/errors.ts";

/**
 * The reset ends with a CHECKPOINT so that every round starts with Postgres's timed-checkpoint clock at zero
 * (gh-584). When Postgres refuses it, the round cannot be made comparable and the measurement has to stop saying
 * why — not with a bare "internal error" and not with a 204 that left the clock running (ADR 0021).
 */
describe("a CHECKPOINT the database refused", () => {
  it("names the privilege when the cause is insufficient_privilege", () => {
    const cause = Object.assign(new Error("permission denied to execute CHECKPOINT command"), { code: "42501" });
    const err = checkpointError(cause);
    expect(err).toBeInstanceOf(CheckpointError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/superuser|pg_checkpoint/);
    expect(err.message).toMatch(/gh-584/);
    expect(err.cause).toBe(cause);
  });

  it("still says it was the CHECKPOINT that failed when the cause is anything else", () => {
    const cause = new Error("the connection was closed");
    const err = checkpointError(cause);
    expect(err).toBeInstanceOf(CheckpointError);
    expect(err.message).toMatch(/CHECKPOINT/);
    expect(err.message).toContain("the connection was closed");
    expect(err.cause).toBe(cause);
  });

  it("does not lose a cause that is not an Error", () => {
    const err = checkpointError("socket hang up");
    expect(err.message).toContain("socket hang up");
    expect(err.cause).toBe("socket hang up");
  });
});
