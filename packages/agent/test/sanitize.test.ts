import { describe, expect, it } from "vitest";
import {
  MESSAGE_RULES,
  meaningful,
  sanitizeMessage,
  sanitizeValues,
  sanitizeWith,
  VALUE_PATTERNS,
} from "../src/sanitize.ts";
import { SANITISER_CASES } from "./support/sanitiser-cases.ts";

/**
 * Invariant 5, asked of each rule of the sanitiser on its own (gh-651).
 *
 * A list of hostile messages asks the rules together, and together they hid that most of them could be deleted
 * with every test green: each message carried something a second rule caught as well. So this asks per rule what
 * comes out without it. The rules are the list `sanitizeMessage` runs and the loop is the one it runs them with,
 * both taken from the source: a copy of either would only check what somebody remembered to copy.
 */

/** The source's own list, one rule short. */
const without = (rule: RegExp): RegExp[] => MESSAGE_RULES.filter((r) => r !== rule);

/** The rules that decide what comes out of a message: the ones without which something else would. */
const decidersOf = (message: string): RegExp[] =>
  MESSAGE_RULES.filter((rule) => sanitizeWith(message, without(rule)) !== sanitizeMessage(message));

/** The cases that `rule` decides and no other rule does. */
const decidedBy = (rule: RegExp) =>
  SANITISER_CASES.filter(({ message }) => {
    const deciders = decidersOf(message);
    return deciders.length === 1 && deciders[0] === rule;
  });

/** Whether `rule` is the only thing between the value of one of the cases and the wire. */
const standsAlone = (rule: RegExp): boolean =>
  SANITISER_CASES.some(({ message, value }) => sanitizeWith(message, without(rule)).includes(value));

/** The rules as the source lists them, each named by its own source so a red says which one. */
const rules = (list: readonly RegExp[]) => list.map((rule) => [String(rule), rule] as const);

/** The cases, each named by its message as written. */
const cases = SANITISER_CASES.map((c) => [c.message, c] as const);

describe("a case of each rule", () => {
  it.each(cases)("keeps nothing of the value in «%s»", (message, { value, sanitised }) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
    expect(sanitised).not.toContain(value);
  });

  it.each(cases)("is decided by one rule and no other: «%s»", (message) => {
    // Two would mean either could be deleted and the suite would not notice, which is what gh-651 found.
    expect(decidersOf(message).map(String)).toHaveLength(1);
  });
});

describe("each rule, as the source lists them", () => {
  it.each(rules(MESSAGE_RULES))("%s decides a case that no other rule decides", (_name, rule) => {
    const decided = decidedBy(rule).map(({ message }) => message);
    expect(decided, "add a case that only this rule decides to test/support/sanitiser-cases.ts").not.toHaveLength(0);
  });

  it("stands alone between a value and the wire, every rule but the one for UUIDs", () => {
    const covered = MESSAGE_RULES.filter((rule) => !standsAlone(rule));
    expect(covered.map(String), "the rules without which no value of a case gets out").toHaveLength(1);
    // A UUID is 36 characters of the long run's own class, hyphens included, so without its rule the long run takes
    // it whole. What this rule decides is the word glued to it, which it leaves and the long run would take; that is
    // what it stays for (ADR 0167).
    const [rule] = covered;
    const shape = rule === undefined ? undefined : decidedBy(rule)[0];
    expect(shape?.value).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    if (rule === undefined || shape === undefined) return;
    const left = sanitizeWith(shape.message, without(rule));
    expect(left).not.toContain(shape.value);
    expect(left).not.toBe(shape.sanitised);
  });

  // `sanitizeValues` runs only these, for what is a name and not a sentence: a quoted SQL identifier and the key of a
  // context. Whatever a pattern decides in a message it decides there too.
  it.each(rules(VALUE_PATTERNS))("%s decides its case the same way in a name", (_name, rule) => {
    const decided = decidedBy(rule);
    expect(decided).not.toHaveLength(0);
    for (const { message, sanitised } of decided) expect(sanitizeValues(message)).toBe(sanitised);
  });
});

describe("what is left once the values are gone", () => {
  it("is one `?` for a run of values, whatever punctuation separates them", () => {
    // «expected 1, 2, 3» and «expected 4, 5» are the same error, and three question marks would make them two.
    expect(sanitizeMessage("expected 1, 2; 3: 4 got 5")).toBe("expected ? got ?");
  });

  it("has one space wherever there was more than one", () => {
    // A message that differs only in how it was wrapped or indented is the same message.
    expect(sanitizeMessage("connection\n\tterminated   unexpectedly")).toBe("connection terminated unexpectedly");
  });

  it("has nothing at either end", () => {
    expect(sanitizeMessage(" connection terminated unexpectedly ")).toBe("connection terminated unexpectedly");
  });

  it("travels with exactly half of its words, and not with fewer", () => {
    // Half is the threshold, and generous towards omitting (ADR 0084): «user ?» is what an unterminated quote leaves.
    expect(meaningful("user ?")).toBe(true);
    expect(meaningful("? user ? or ?")).toBe(false);
  });
});
