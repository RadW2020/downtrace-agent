import { describe, expect, it } from "vitest";
import { type DependencyKind, enterRequest, recordCallIn } from "../src/context.ts";

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
