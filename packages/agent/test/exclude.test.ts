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
});
