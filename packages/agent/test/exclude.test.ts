import { describe, expect, it } from "vitest";
import { Excluded, patternsOf } from "../src/exclude.ts";

describe("patternsOf", () => {
  it("reads a list and drops what is not a pattern", () => {
    expect(patternsOf("/admin/*, /internal")).toEqual(["/admin/*", "/internal"]);
    // A blank between commas would compile to a pattern matching the empty string, and a stray comma in a
    // deployment variable must not turn into «exclude something».
    expect(patternsOf("/admin/*,, ,")).toEqual(["/admin/*"]);
    expect(patternsOf(undefined)).toEqual([]);
    expect(patternsOf("   ")).toEqual([]);
  });
});

describe("Excluded", () => {
  it("matches a whole name, with * standing for any run", () => {
    const e = new Excluded(["/admin/*"]);
    expect(e.has("/admin/users")).toBe(true);
    expect(e.has("/admin/")).toBe(true);
    // Anchored: a route that merely contains the pattern is a different route.
    expect(e.has("/public/admin/users")).toBe(false);
    expect(e.has("/products")).toBe(false);
  });

  it("takes the rest of a pattern literally", () => {
    // What a regular expression would read as syntax is just characters here, so a user cannot write one
    // by accident and cannot write a slow one on purpose.
    const e = new Excluded(["/a.b/+c"]);
    expect(e.has("/a.b/+c")).toBe(true);
    expect(e.has("/axb/+c")).toBe(false);
  });

  it("excludes nothing when nothing was asked for", () => {
    const e = new Excluded([]);
    expect(e.has("/admin/users")).toBe(false);
    expect(e.configured).toBe(false);
    expect(e.count).toBe(0);
  });

  it("counts distinct names it really excluded, not patterns configured", () => {
    // What a reader wants to know is how many are missing from the numbers in front of them, and a pattern
    // that matches nothing is not missing from anything.
    const e = new Excluded(["/admin/*", "/nothing-matches-this"]);
    for (let i = 0; i < 100; i++) {
      e.has("/admin/users");
      e.has("/admin/settings");
      e.has("/products");
    }
    expect(e.count).toBe(2);
  });

  it("answers from memory after the first time", () => {
    const e = new Excluded(["/admin/*"]);
    expect(e.has("/admin/users")).toBe(true);
    expect(e.has("/admin/users")).toBe(true);
    expect(e.count).toBe(1);
  });

  // gh-765. The decision remembered every name ever evaluated, for the whole life of the process. The
  // decisions have a cap now: what falls out of them is re-decided on the spot, and the count of distinct
  // excluded names saturates at its cap, where it is a lower bound — no bounded memory counts further.
  it("remembers a bounded number of names, and the count is a lower bound once it saturates", () => {
    const e = new Excluded(["*"], { decisions: 8, excluded: 8 });
    for (let i = 0; i < 50; i += 1) expect(e.has(`/r/${i}`)).toBe(true);

    expect(e.count).toBe(8);
    // The names that fell out of the decisions are still answered, from the pattern.
    expect(e.has("/r/7")).toBe(true);
    expect(e.has("/r/49")).toBe(true);
    // And re-asking does not re-count: the count stays where it saturated.
    expect(e.count).toBe(8);
  });

  it("bounds its memory at the names it may keep", () => {
    const e = new Excluded(["*"], { decisions: 8, excluded: 8 });
    for (let i = 0; i < 50; i += 1) e.has("n".repeat(256));
    const at = e.bytes();
    for (let i = 0; i < 50; i += 1) e.has("n".repeat(256));
    expect(e.bytes()).toBe(at);
  });
});
