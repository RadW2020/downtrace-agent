import { describe, expect, it } from "vitest";
import {
  type DependencyKind,
  enterRequest,
  operationKey,
  recordCallIn,
  recordOperationIn,
  recordWaitIn,
} from "../src/context.ts";
import { FineRegister } from "../src/fine.ts";

/**
 * What the key separator is for. The character itself is an implementation detail — it was a raw NUL byte until
 * gh-314 made git treat the whole file as binary — and this is the property that has to survive whatever it
 * becomes: two different dependencies within one request are two entries, never one.
 */
describe("a request's dependency counters", () => {
  it("keeps two different dependencies apart", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "http", "api.stripe.com", 10);
    recordCallIn(ctx, "http", "api.sendgrid.com", 20);
    recordCallIn(ctx, "postgres", "api.stripe.com", 30);

    expect(ctx.work?.size).toBe(3);
    expect([...(ctx.work?.values() ?? [])].map((w) => w.ms)).toEqual([10, 20, 30]);
  });

  it("does not confuse a kind with no target for the same kind with one", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "postgres", "", 10);
    recordCallIn(ctx, "postgres", "replica", 20);

    expect(ctx.work?.size).toBe(2);
  });

  /**
   * The collision the separator prevents, written so it cannot pass by accident: a target that starts with
   * another kind's name. With a separator that can appear inside either half, `("http", "sql:x")` and
   * `("http:sql", "x")` would be one row. Kinds are a closed set of lowercase words today, so the cast is the
   * only way to write the pair that would collide — and it is the pair a future kind could make real.
   */
  it("cannot be made to collide by a target that reads like a key", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "http", "postgres:db", 10);
    recordCallIn(ctx, "http:postgres" as DependencyKind, "db", 20);

    expect(ctx.work?.size).toBe(2);
  });

  /**
   * And the collision that needs no separator at all to be wrong: one kind whose name is a prefix of another's.
   * The four kinds today are not, so dropping the separator breaks nothing — which is precisely why this has to
   * be written down before a fifth arrives.
   */
  it("cannot be made to collide by a kind that prefixes another", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "http" as DependencyKind, "2/api", 10);
    recordCallIn(ctx, "http2" as DependencyKind, "/api", 20);

    expect(ctx.work?.size).toBe(2);
  });

  it("adds a repeated dependency to the same entry instead of splitting it", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "redis", "cache", 10);
    recordCallIn(ctx, "redis", "cache", 5, true);

    expect(ctx.work?.size).toBe(1);
    const entry = [...(ctx.work?.values() ?? [])][0];
    expect(entry).toMatchObject({ calls: 2, ms: 15, maxMs: 10, errors: 1 });
  });
});

// `product.md:104`: excluding a dependency completely, and not observing it rather than observing and
// dropping it (gh-361, ADR 0101).
describe("a dependency the operator excluded", () => {
  const excluding = (...targets: string[]) => ({ has: (t: string) => targets.includes(t) });

  it("records neither its calls nor its waits", () => {
    const ctx = enterRequest(undefined, 0, excluding("secrets.internal:5432"));
    recordCallIn(ctx, "postgres", "secrets.internal:5432", 5);
    recordWaitIn(ctx, "postgres", "secrets.internal:5432", 2);
    recordCallIn(ctx, "postgres", "orders.internal:5432", 3);
    const targets = [...(ctx.work?.values() ?? [])].map((w) => w.target);
    expect(targets).toEqual(["orders.internal:5432"]);
  });

  it("leaves everything alone when nothing was excluded", () => {
    const ctx = enterRequest();
    recordCallIn(ctx, "postgres", "orders.internal:5432", 3);
    expect(ctx.work?.size).toBe(1);
  });
});

/**
 * DT-17. An outgoing call and a Redis command are operations now, recorded through `recordOperationIn` on every
 * call they make — not once per failure, as the three kinds of error are. Three things follow, and these pin them.
 */
describe("an operation recorded against a request", () => {
  const excluding = (...targets: string[]) => ({ has: (t: string) => targets.includes(t) });
  const call = (target: string, key?: string) => ({
    kind: "call" as const,
    fingerprint: { hash: "c0ffee00c0ffee00", text: "POST api.stripe.com", ...(key === undefined ? {} : { key }) },
    startedAt: 2,
    endedAt: 9,
    target,
  });

  // `product.md:104`, ADR 0101: excluding is not observing. An excluded dependency leaves neither its counters
  // nor what it ran, in the profile or in the black box.
  it("records nothing of a dependency the operator excluded, in the profile or in the black box", () => {
    const fine = new FineRegister();
    const ctx = enterRequest(fine, 0, excluding("api.stripe.com"));
    recordOperationIn(ctx, call("api.stripe.com"));
    expect(ctx.operations, "an excluded dependency runs nothing a profile can see").toBeUndefined();
    expect(ctx.fineOps, "nor anything the black box keeps").toBe(0);

    recordOperationIn(ctx, call("api.sendgrid.com"));
    expect(ctx.operations?.size).toBe(1);
    expect(ctx.fineOps).toBe(1);
  });

  // Invariant 3: the key that tells a call apart from a query of the same hash is made once, in the bounded
  // cache that made the fingerprint, and not concatenated again on every call.
  it("keys the operation by the key its fingerprint already carries, and keeps it for the profile", () => {
    const ctx = enterRequest();
    recordOperationIn(ctx, call("api.stripe.com", "made-once"));
    recordOperationIn(ctx, call("api.stripe.com", "made-once"));
    expect([...(ctx.operations?.keys() ?? [])]).toEqual(["made-once"]);
    expect(ctx.operations?.get("made-once")).toMatchObject({ kind: "call", count: 2, key: "made-once" });
  });

  it("makes the key itself when the fingerprint carries none, as a query's and an error's do", () => {
    const ctx = enterRequest();
    recordOperationIn(ctx, call("api.stripe.com"));
    const [key] = ctx.operations?.keys() ?? [];
    expect(key).toBe(operationKey("call", "c0ffee00c0ffee00"));
    expect(ctx.operations?.get(key ?? "")?.key).toBe(key);
  });

  // ADR 0219: the evidence names the kind of every operation, so the black box has to keep it.
  it("hands the black box the kind of what it ran", () => {
    const fine = new FineRegister();
    const ctx = enterRequest(fine, 0);
    recordOperationIn(ctx, call("api.stripe.com"));
    recordOperationIn(ctx, { kind: "query", fingerprint: { hash: "q", text: "SELECT ?" }, startedAt: 9, endedAt: 10 });
    fine.request("POST", "/checkout", 200, 0, 10, ctx.fineFrom, ctx.fineOps);
    expect(fine.snapshot().requests[0]?.operations.map((o) => o.kind)).toEqual(["call", "query"]);
  });
});
