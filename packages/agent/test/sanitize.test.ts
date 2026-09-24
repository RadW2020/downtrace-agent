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

describe("what a URL keeps", () => {
  // Its scheme, and a host and a port when that is all the authority holds: the shape a dependency target already
  // travels in. Everything after the authority goes, and any other authority goes whole with it (ADR 0170).
  it.each([
    // The port is kept by this rule; the digit rule then takes it, as it takes any number.
    ["request to http://localhost:3000/users/alice failed", "request to http://localhost:?/? failed"],
    ["see https://api.example.com#alice", "see https://api.example.com#?"],
    ["see https://api.example.com?name=alice", "see https://api.example.com?"],
    // An `@` after the host is not a userinfo, and it does not stop the path from going.
    ["see https://api.example.com/users/@alice/posts", "see https://api.example.com/?"],
    ["open file:///home/alice/orders.csv", "open file:///?"],
    // A user with no password, and a host with no dot in it, which the email rule would not take.
    ["could not connect to https://payroll@localhost/orders", "could not connect to https://?"],
    // A password with a `/` in it is not a URL, and it is exactly the one a rule guessing where it ends would cut.
    ["could not connect to postgres://payroll:hun/ter@db.internal/orders", "could not connect to postgres://?"],
    ["could not connect to http://[::1]:3000/alice", "could not connect to http://?"],
  ])("«%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  it("is left alone when there is nothing after its host", () => {
    expect(sanitizeMessage("request to https://api.example.com failed")).toBe(
      "request to https://api.example.com failed",
    );
  });
});

describe("what a quote is", () => {
  it("is not an apostrophe, although `’` is both", () => {
    expect(sanitizeMessage("can’t reach the server")).toBe("can’t reach the server");
  });

  it("closes only with a mark of its own family, so an apostrophe inside a quote does not end it", () => {
    // One rule for every quote would stop at `’` and let `alice` out.
    expect(sanitizeMessage("user “it’s alice” not found")).toBe("user ? not found");
  });
});

/**
 * The rules as they were before gh-684, frozen here on purpose.
 *
 * Not a copy of the source to check the source against: the source is meant to differ from these. They are what
 * every signature a cloud already holds was computed with, because an error's identity is the hash of what they left
 * (ADR 0083), and so the one thing an upgrade must leave where it was for every message that carries none of the new
 * shapes (ADR 0170).
 */
const BEFORE_GH_684: readonly RegExp[] = [
  /'[^']*'?/g,
  /"[^"]*"?/g,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[0-9a-zA-Z_-]{16,}\b/g,
  /\b\w*\d[\w.]*\b/g,
];
/** And the ones a name went through, which are the same without the quotes. */
const VALUES_BEFORE_GH_684 = BEFORE_GH_684.slice(2);

/**
 * Messages made only of ASCII, with neither of the two ASCII shapes gh-684 added a rule for: a backtick and `://`.
 *
 * Built from pieces each old rule catches, glued with and without spaces so that the pieces also meet, and from any
 * other printable character. Seeded, so a red names a message that comes back on the next run.
 */
function asciiMessages(count: number): string[] {
  let seed = 684;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pieces = [
    ...["user", "not", "found", "order", "can't", "_", "-", "--", ".", ",", ";", ":", "@", "(", ")", "=", "/", "?"],
    ...["4821", "v1.2.3", "1.", "x9", "0x1f", "ana@cliente.com", "a.b@c", "tok_abcdefghijklmnop"],
    // Either side of the long run's length, which no other piece sits on.
    ...["abcdefghijklmno", "abcdefghijklmnop"],
    ...["'alice'", "'alice", '"bob"', '"bob', "alice_smith_marketing", "5b6d1f0e-2c3a-4d5e-8f90-1a2b3c4d5e6f"],
  ];
  const messages: string[] = [];
  while (messages.length < count) {
    let message = "";
    const length = 1 + Math.floor(next() * 12);
    for (let i = 0; i < length; i++) {
      const piece = pieces[Math.floor(next() * pieces.length)] ?? "";
      message += next() < 0.6 ? piece : String.fromCharCode(32 + Math.floor(next() * 95));
      if (next() < 0.5) message += " ";
    }
    if (!message.includes("`") && !message.includes("://")) messages.push(message);
  }
  return messages;
}

describe("what an upgrade leaves where it was", () => {
  const messages = asciiMessages(5000);

  it("is every message made only of ASCII with no backtick and no `://`: it comes out as it did before gh-684", () => {
    for (const message of messages) {
      expect(sanitizeMessage(message), `«${message}» as a message`).toBe(sanitizeWith(message, BEFORE_GH_684));
      expect(sanitizeValues(message), `«${message}» as a name`).toBe(sanitizeWith(message, VALUES_BEFORE_GH_684));
    }
  });

  it("asks each of those rules: every one of them changes some of these messages", () => {
    // Or the test above could be passing on messages that no rule touches.
    for (const rule of BEFORE_GH_684) {
      const touched = messages.filter((m) => sanitizeWith(m, [rule]) !== sanitizeWith(m, []));
      expect(touched.length, String(rule)).toBeGreaterThan(100);
    }
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
