import { describe, expect, it } from "vitest";
import { heuristicTemplate } from "../src/routes.ts";
import {
  MESSAGE_RULES,
  meaningful,
  SEGMENT_RULES,
  type SegmentRule,
  sanitizeMessage,
  sanitizeValues,
  sanitizeWith,
  VALUE_PATTERNS,
} from "../src/sanitize.ts";
import { SANITISER_CASES } from "./support/sanitiser-cases.ts";
import { SEGMENT_CASES } from "./support/segment-cases.ts";

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

/**
 * A segment of a route without a template, asked of the rules of `src/routes.ts`'s heuristic (gh-756).
 *
 * The question is the one this file answers — «is this a value?» — and the answer is not the messages':
 * in a route, a version separates two endpoints the product has to keep apart, and a long kebab-case word
 * is the naming convention. So the heuristic runs its own list, and this asks that list the same question
 * gh-651 asked of the others: what comes out without each rule, and which rule decides which case.
 */

/** The source's own list, one rule short. */
const segmentRulesWithout = (rule: SegmentRule): SegmentRule[] => SEGMENT_RULES.filter((r) => r !== rule);

/** The rules that decide what a segment becomes: the ones without which it would be something else. */
const segmentDecidersOf = (segment: string): SegmentRule[] =>
  SEGMENT_RULES.filter((rule) => {
    const withAll = SEGMENT_RULES.some((r) => r(segment));
    const withoutOne = segmentRulesWithout(rule).some((r) => r(segment));
    return withAll !== withoutOne;
  });

describe("a case of each rule that reads a segment of a route", () => {
  const segments = SEGMENT_CASES.map((c) => [c.segment, c] as const);

  it.each(segments)("keeps nothing of the value in «%s»", (segment, { value }) => {
    // The unit is the segment: it becomes `:id` whole, and nothing of the value is left beside the mark.
    const route = heuristicTemplate(`/pre/${segment}/post`);
    expect(route).toBe("/pre/:id/post");
    expect(route).not.toContain(value);
  });

  it.each(segments)("is decided by one rule and no other: «%s»", (segment) => {
    // Two would mean either could be deleted and the suite would not notice, which is what gh-651 found.
    expect(segmentDecidersOf(segment).map((rule) => rule.name)).toHaveLength(1);
  });
});

describe("each segment rule, as the source lists them", () => {
  const segmentRules = SEGMENT_RULES.map((rule) => [rule.name, rule] as const);

  it.each(segmentRules)("«%s» decides a case that no other rule decides", (_name, rule) => {
    const decided = SEGMENT_CASES.filter(({ segment }) => {
      const deciders = segmentDecidersOf(segment);
      return deciders.length === 1 && deciders[0] === rule;
    }).map(({ segment }) => segment);
    expect(decided, `add a case that only ${_name} decides to test/support/segment-cases.ts`).not.toHaveLength(0);
  });
});

describe("what the heuristic upgrade leaves where it was", () => {
  // The heuristic as it was before gh-756, frozen here on purpose: it is what every route a cloud already
  // holds was named with, so a segment none of the new shapes touches must come out as it did.
  const OLD_NUMERIC = /^\d+$/;
  const OLD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const OLD_HEX_ID = /^(?:[0-9a-f]{24}|[0-9a-f]{32,})$/i;
  const frozenTemplate = (url: string): string => {
    const path = url.split(/[?#]/, 1)[0] ?? "/";
    const segments = path
      .split("/")
      .map((s) => (s !== "" && (OLD_NUMERIC.test(s) || OLD_UUID.test(s) || OLD_HEX_ID.test(s)) ? ":id" : s));
    const joined = segments.join("/") || "/";
    return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
  };

  // What a segment none of the new rules reads: no `@`, no `%`, no digit outside a version, and no run of 16
  // or more letters, digits, `_` or `-` with an uppercase in it. Written from the shapes and not from the
  // rules, so it bounds what the corpus may carry instead of copying the rules.
  const RUN = /[\p{L}\p{M}\p{N}_-]{16,}/gu;
  const noNewShape = (piece: string): boolean =>
    !piece.includes("@") &&
    !piece.includes("%") &&
    (!/\p{N}/u.test(piece) || /^[vV][0-9]+(?:\.[0-9]+)*$/.test(piece)) &&
    ![...piece.matchAll(RUN)].some((run) => /\p{Lu}/u.test(run[0]));

  it("is every path made of segments none of the new shapes touches: it comes out as it did before gh-756", () => {
    // Built from pieces each old rule or no rule catches, glued with `/` so the segments meet. Seeded, so a
    // red names a path that comes back on the next run.
    const pieces = [
      "alice",
      "john.smith",
      "healthz",
      "api",
      "v1",
      "v2",
      "v10",
      "v1.2",
      "V2",
      "orders",
      "checkout",
      "openid-configuration",
      "password-reset-requests",
      "my-first-post-about-kubernetes",
      "invoice.pdf",
      "JohnSmith",
      "post.byId",
      "well-known",
    ];
    for (const piece of pieces) expect(noNewShape(piece), `«${piece}»`).toBe(true);
    let seed = 756;
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (seed >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const length = 1 + Math.floor(next() * 5);
      const segments: string[] = [];
      for (let j = 0; j < length; j++) segments.push(pieces[Math.floor(next() * pieces.length)] ?? "orders");
      const url = `/${segments.join("/")}`;
      expect(heuristicTemplate(url), `«${url}» as the heuristic reads it now`).toBe(frozenTemplate(url));
    }
  });

  it.each([
    "42",
    "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    "507f1f77bcf86cd799439011",
    "3f786850e387550fdab836ed7e6dc881de23001b",
  ])("still folds what the old rules folded: «%s»", (segment) => {
    expect(heuristicTemplate(`/${segment}`)).toBe("/:id");
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
    // A `\` ends a host where a `/` would, as the parser reads it (gh-713): straight after the slashes, which leaves an
    // empty host, and after a port, which is a host and a port and keeps them.
    ["request to https://\\api.example.com\\users\\alice failed", "request to https://\\? failed"],
    ["request to https://api.example.com:8080\\users\\alice failed", "request to https://api.example.com:?\\? failed"],
    // In a scheme that is not special too, where the parser refuses a `\` in a host: nothing after one is a host.
    ["could not connect to postgres://db.internal\\orders\\alice", "could not connect to postgres://db.internal\\?"],
    // A special scheme with no slashes after it: a user takes the rest with it, as after `://`, and the scheme is read
    // in any case, since the parser lowercases it.
    ["could not connect to https:payroll@localhost", "could not connect to https:?"],
    ["request to HTTPS:api.example.com?name=alice failed", "request to HTTPS:api.example.com? failed"],
    // What follows `file:` is a path to the parser, and a word with no separator stays wherever it is; its query goes.
    ["open file:orders.csv?name=alice", "open file:orders.csv?"],
  ])("«%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  it("is left alone when there is nothing after its host", () => {
    expect(sanitizeMessage("request to https://api.example.com failed")).toBe(
      "request to https://api.example.com failed",
    );
  });

  // `rows` is the scheme of `rows:id:desc`, and not `ws`; read as `ws:` it would go whole, as an authority that is not
  // a host. A scheme's name is letters, digits, `+`, `-` and `.`, and the parser reads it whole.
  it.each(["rows", "git+ws", "x-ws", "a.ws", "sftp", "profile"])(
    "has the scheme the parser reads, so «%s:», which only ends like a special one, is not one",
    (name) => {
      expect(new URL(`${name}:id:desc`).protocol).toBe(`${name}:`);
      expect(sanitizeMessage(`sort by ${name}:id:desc`)).toBe(`sort by ${name}:id:desc`);
    },
  );
});

describe("where a URL's host ends", () => {
  // Where Node's own URL parser ends it, and not where a list of separators written here says (gh-713). Each code point
  // below 128 is put, in turn, in each place of a URL where the parser may end a host, in each of the six schemes the
  // URL standard calls special. Wherever the parser still reads the host as written, nothing it reads outside that host
  // may come out. Below 128 because the parser tells the parts of a URL apart by ASCII alone: a code point beyond it in
  // a host is mapped or refused by IDNA, and none of the BMP ends a host (measured on the branch of gh-713).
  const SPECIAL = ["http", "https", "ws", "wss", "ftp", "file"];
  const HOST = "api.example.com";
  // A user is written in front of a host with no dot in it, which the email rule would not take.
  const PLACES: [string, string, (scheme: string, c: string) => string][] = [
    ["after the host", HOST, (s, c) => `${s}://${HOST}${c}alice`],
    ["after its port", HOST, (s, c) => `${s}://${HOST}:8080${c}alice`],
    ["after a user", "localhost", (s, c) => `${s}://alice${c}localhost`],
    ["straight after the slashes", HOST, (s, c) => `${s}://${c}${HOST}${c}alice`],
    ["in place of each slash", HOST, (s, c) => `${s}:${c}${c}${HOST}${c}alice`],
    ["with no slashes", HOST, (s, c) => `${s}:${HOST}${c}alice`],
    ["after a user, with no slashes", "localhost", (s, c) => `${s}:alice${c}localhost`],
  ];

  /** What the parser reads outside the host of `url`: nothing when it refuses the URL or reads another host. */
  const outsideTheHost = (url: string, host: string): string => {
    if (!URL.canParse(url)) return "";
    const parsed = new URL(url);
    if (parsed.hostname !== host) return "";
    return [parsed.username, parsed.password, parsed.pathname, parsed.search, parsed.hash].join(" ");
  };

  it.each(PLACES)("keeps nothing the parser reads outside it, %s, for every code point below 128", (_, host, url) => {
    const asked: string[] = [];
    for (const scheme of SPECIAL) {
      for (let code = 0; code < 128; code++) {
        const written = url(scheme, String.fromCharCode(code));
        if (!outsideTheHost(written, host).includes("alice")) continue;
        asked.push(written);
        expect(sanitizeMessage(`request to ${written} failed`), JSON.stringify(written)).not.toContain("alice");
      }
    }
    // Or this could be passing in a place where the parser never ends a host.
    expect(asked).not.toHaveLength(0);
  });
});

describe("what a path is", () => {
  // A word with a `/` or a `\` in it and something else besides, which goes whole: nothing of it stays, its first
  // segment included, because whether a plain word is structure or a value is what no rule can tell. A word that
  // opens with a URL is the URL rule's, and keeps what that rule lets it keep (gh-697).
  it.each([
    ["no route for GET /users/alice", "no route for GET ?"],
    // Glued to the word in front of it, it takes that word with it.
    ["Route GET:/users/alice not found", "Route ? not found"],
    // Node's own, measured: the ESM loader names the importing file by its absolute path and without quotes.
    ["Cannot find package 'left-pad' imported from /home/alice/app/index.mjs", "Cannot find package ? imported from ?"],
    [
      "Cannot find package 'left-pad' imported from C:\\Users\\alice\\app\\index.mjs",
      "Cannot find package ? imported from ?",
    ],
    // And `net`, for a Unix socket.
    ["connect ENOENT /tmp/app.sock", "connect ENOENT ?"],
    // One separator is enough, and a share is a path like any other.
    ["cannot read alice/orders.csv", "cannot read ?"],
    ["cannot read \\\\fileserver\\alice\\orders.csv", "cannot read ?"],
    ["see //cdn.example.com/alice", "see ?"],
    // A URL in its query does not make the word a URL: it opens with a path, and goes whole.
    ["no route for /users/alice?next=https://app.example.com/home", "no route for ?"],
    // And a word that opens with one is the URL rule's, whatever comes before its `://`.
    ["redirect to=https://api.example.com/users/alice", "redirect to=https://api.example.com/?"],
    // The cost, and ADR 0083's trade: a word that only joins two words with a slash goes too.
    ["EIO: i/o error, read", "EIO: ? error, read"],
  ])("«%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  it("is not a slash on its own, which is punctuation", () => {
    expect(sanitizeMessage("read / write failed")).toBe("read / write failed");
    expect(sanitizeMessage("read // write failed")).toBe("read // write failed");
  });

  it("is not a host on its own, with no separator after it", () => {
    expect(sanitizeMessage("getaddrinfo ENOTFOUND api.example.com")).toBe("getaddrinfo ENOTFOUND api.example.com");
  });

  // What the rule cannot do, said in a test so that the README's wording and the code agree: with no quotes to go
  // by, a space is where a word ends, and a path with one in it is two words.
  it("ends at a space, and the README says so", () => {
    expect(sanitizeMessage("cannot read /home/alice/My Documents")).toBe("cannot read ? Documents");
  });

  it("ends at nothing else: a comma or a parenthesis inside it is still the path", () => {
    // A rule that stopped at either would leave what follows it, which is as much the name of a thing.
    expect(sanitizeMessage("cannot read /srv/exports/orders,alice")).toBe("cannot read ?");
    expect(sanitizeMessage("cannot read C:\\exports\\orders(alice).csv")).toBe("cannot read ?");
  });

  it("is the quotes' when it is between them, space and all, because the quotes are read first", () => {
    // How Node's `fs` names a path. Were the path read before its quotes, it would end at the space and leave
    // `Documents` for the quote to close on.
    expect(sanitizeMessage("ENOENT: no such file or directory, scandir '/home/alice/My Documents'")).toBe(
      "ENOENT: no such file or directory, scandir ?",
    );
  });
});

describe("what a query is", () => {
  // A `?` in a word with a letter, a digit or an `_` after it, and no `/` or `\` before it: a query that follows no path
  // and no URL whose authority the URL rule reads. The whole word goes, whatever stands in front of it (gh-720).
  it.each([
    // A scheme that only ends like a special one is a scheme like any other that is not special.
    ["sort by rows:id?dir=alice", "sort by ?"],
    // Whatever is between the `?` and the value, another `?` included.
    ["no handler for ??name=alice", "no handler for ?"],
    ["no handler for ?&name=alice", "no handler for ?"],
    // A URL in its query does not shield it, as it does not shield a path.
    ["GET api.example.com?user=alice&next=https://app.example.com/home failed", "GET ? failed"],
    // A word a closed quote is glued to: what the quote leaves is a `?` with a letter after it. A double quote, since a
    // `'` with a letter after it no longer closes a span (gh-732).
    ['user "alice"smith not found', "user ? not found"],
    // A letter of any script, a digit or an `_`, as a word is read everywhere here. With a digit the digit rule would
    // take the value and leave the host; an `_` is the name of jQuery's cache-buster, before its value.
    ["no handler for ?имя=алиса", "no handler for ?"],
    ["GET api.example.com?4821 failed", "GET ? failed"],
    ["GET api.example.com?_= failed", "GET ? failed"],
  ])("«%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // After a separator, either of them, a query is the path's, and the rule for a path takes the word whole. Were this
  // rule to take it too, neither would decide it, and the guard of gh-651 could not tell if one of them were gone.
  it.each(["no route for /users/alice?name=alice", "cannot read C:\\Users\\alice?name=alice"])(
    "is not the one that decides «%s», which only the rule for a path does",
    (message) => {
      // Named by what it decides and not by its place in the list: the rule that takes a path with no query in it.
      const path = decidersOf("cannot read /home/alice/orders.csv").map(String);
      expect(path).toHaveLength(1);
      expect(sanitizeMessage(message)).not.toContain("alice");
      expect(decidersOf(message).map(String)).toEqual(path);
    },
  );

  // Each of these is left as it was: a `?` with nothing after it, or nothing but punctuation, is punctuation, and so is
  // the `?` a URL's query leaves.
  it.each([
    ["unexpected token?", "unexpected token?"],
    ["expected a value, got ?", "expected a value, got ?"],
    ["is it null?). no", "is it null?). no"],
    // Placeholders written without spaces, which the collapse of a run of values makes one.
    ["VALUES (?,?,?) failed", "VALUES (?) failed"],
    ["see https://api.example.com?name=alice", "see https://api.example.com?"],
  ])("is not in «%s», which comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  it("is not the `?` a later rule leaves, which is a value glued to a word, as `order-?` is", () => {
    // Read after the digit rule, `x9-alice` would lose `-alice`, and a message with no `?` in it would move identity.
    expect(sanitizeMessage("build x9-alice failed")).toBe("build ?-alice failed");
  });

  // Node's parser as the judge, as for where a URL's host ends. Each code point below 128 is put in each place of a
  // query, after each thing a query may follow with no URL rule to read it, and wherever the parser reads the value in
  // the query, the value may not come out. The word is read as a URL when it is one, and as a reference against a base
  // when it is not. Whitespace is left out: to the sanitiser it ends a word, as it ends a path (ADR 0175), and what
  // follows it is a word of its own, while the parser removes a tab or a newline and reads on.
  const BASE = "http://base.invalid/";
  const BEFORE = [
    "api.example.com",
    "",
    "sms:ops",
    "magnet:",
    "mailto:ops@cliente.com",
    // A scheme that only ends like a special one, which the URL rule leaves alone.
    "rows:id",
  ];
  const PLACES: [string, (before: string, c: string) => string][] = [
    ["right after the `?`", (before, c) => `${before}?${c}alice`],
    ["between a name and its value", (before, c) => `${before}?name${c}alice`],
    ["right before the `?`", (before, c) => `${before}${c}?name=alice`],
  ];

  /** What the parser reads as the query of `word`: nothing when it refuses it. */
  const inTheQuery = (word: string): string => (URL.canParse(word, BASE) ? new URL(word, BASE).search : "");

  it.each(PLACES)("keeps nothing the parser reads in it, %s, for every code point below 128", (_, place) => {
    const asked: string[] = [];
    for (const before of BEFORE) {
      for (let code = 0; code < 128; code++) {
        const c = String.fromCharCode(code);
        if (/\s/.test(c)) continue;
        const written = place(before, c);
        if (!inTheQuery(written).includes("alice")) continue;
        asked.push(written);
        expect(sanitizeMessage(`GET ${written} failed`), JSON.stringify(written)).not.toContain("alice");
      }
    }
    // Or this could be passing in a place where the parser never reads a query.
    expect(asked).not.toHaveLength(0);
  });
});

describe("what a fragment is", () => {
  // The URL rule reads the fragment after a host it reads, the path rule one in a word with a separator, and the
  // query rule one after a `?`. What none of them reads is a `#` inside a word with something before it and a word
  // character after it, and the whole word goes, as a query does: the part before the `#` is a host or a scheme,
  // and the part after it is the value (gh-733, ADR 0193).
  it.each([
    ["GET api.example.com#alice failed", "GET ? failed"],
    ["open sms:ops#alice", "open ?"],
    ["GET magnet:?xt=urn:btih:abc#alice failed", "GET ? failed"],
    // The cost the decision accepts: the same shape as a fragment, and no rule tells one from the other.
    ["failed in Object#method", "failed in ?"],
  ])("goes with its word: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // What is not a fragment, and stays: a `#` at the start of a word names a private field of V8, a ticket or a
  // channel, and a `#` with nothing after it names a language. Taking either would change the signature of an error
  // whose text is structure, and take from it what it says.
  it.each([
    [
      "Cannot read private member #alice from an object whose class did not declare it",
      "Cannot read private member #alice from an object whose class did not declare it",
    ],
    ["issue #alice is open", "issue #alice is open"],
    ["the C# compiler failed", "the C# compiler failed"],
    ["F# code at line 3", "F# code at line ?"],
  ])("is not one: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // Node's parser as the judge, as for where a URL's host ends. Each code point below 128 is put in each place of a
  // fragment, after each thing a fragment may follow with no URL rule to read it, and wherever the parser reads the
  // value in the fragment, the value may not come out. The word is read as a URL when it is one, and as a reference
  // against a base when it is not. Whitespace is left out: to the sanitiser it ends a word, as it ends a query
  // (ADR 0184), and what follows it is a word of its own, while the parser removes a tab or a newline and reads on.
  const BASE = "http://base.invalid/";
  const BEFORE = [
    "api.example.com",
    "",
    "sms:ops",
    "magnet:",
    // A scheme that only ends like a special one, which the URL rule leaves alone.
    "rows:id",
  ];
  // A word that opens with a `#` is the shape a private field, a ticket or a channel takes, and it stays by
  // decision: the `#` must have something before it within the word, so the first place asks for a word of its own.
  const PLACES: [string, (before: string, c: string) => string | null][] = [
    ["right after the word", (before, c) => (before === "" ? null : `${before}#${c}alice`)],
    ["between a name and its value", (before, c) => `${before}ops#${c}alice`],
  ];

  /** What the parser reads as the fragment of `word`: nothing when it refuses it. */
  const inTheFragment = (word: string): string => (URL.canParse(word, BASE) ? new URL(word, BASE).hash : "");

  it.each(PLACES)("keeps nothing the parser reads in it, %s, for every code point below 128", (_, place) => {
    const asked: string[] = [];
    for (const before of BEFORE) {
      for (let code = 0; code < 128; code++) {
        const c = String.fromCharCode(code);
        if (/\s/.test(c)) continue;
        const written = place(before, c);
        if (written === null) continue;
        if (!inTheFragment(written).includes("alice")) continue;
        asked.push(written);
        expect(sanitizeMessage(`GET ${written} failed`), JSON.stringify(written)).not.toContain("alice");
      }
    }
    // Or this could be passing in a place where the parser never reads a fragment.
    expect(asked).not.toHaveLength(0);
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

  // The ASCII `'` is both as well, and it is read by what stands on either side of it (gh-732). The ticket's rows came
  // out as `?`, `?`, `? smith?` and `can?`: the `'` of the contraction opened a span that closed on the value's opening
  // quote. The last two are what Prisma 7.7.0 builds when the database does not answer and what mysql2 3.15.3 throws on
  // a closed connection, and both travelled as `Can?`.
  it.each([
    ["can't find user 'alice'", "can't find user ?"],
    ["user's 'alice' missing", "user's ? missing"],
    ["Can't find user 'alice smith' here", "Can't find user ? here"],
    ["can't reach the server", "can't reach the server"],
    ["Can't reach database server at db.internal:5432", "Can't reach database server at db.internal:?"],
    [
      "Can't add new command when connection is in closed state",
      "Can't add new command when connection is in closed state",
    ],
  ])("is not the apostrophe of a contraction: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // The endings of an English contraction or possessive, in either case: a `'` with a word character before it and one
  // of these after it, ending the word, opens nothing, before a quoted value or with none after it. A word character of
  // any script, as everywhere here.
  it.each(["can't", "user's", "I'd", "I'm", "you're", "I've", "it'll", "CAN'T", "YOU'RE", "José's"])(
    "is not the `'` of «%s»",
    (word) => {
      expect(sanitizeMessage(`${word} find 'alice smith' here`)).toBe(`${word} find ? here`);
      expect(sanitizeMessage(`${word} find nothing here`)).toBe(`${word} find nothing here`);
    },
  );

  // Any other `'` is a quote, one inside a word included. A quote glued to a word and a name with an apostrophe in it are
  // the same shape, and only the ending of a contraction tells an apostrophe apart, so these go as they did.
  it.each([
    ["user'alice' not found", "user? not found"],
    ["user'alice smith not found", "user?"],
    ["near E'alice smith' at line 1", "near E? at line ?"],
    ["user O'Brien not found", "user O?"],
    // The letters after it are an ending only when they end the word, and only after a word: an initial after an opening
    // quote is not a contraction.
    ["user'sally smith' not found", "user? not found"],
    ["user 'D Smith' not found", "user ? not found"],
    // A possessive plural opens one too, and costs the rest of the message, as it did: that is text, not a value.
    ["the users' records", "the users?"],
  ])("is any other `'`: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // And a span closes only where a word ends: at a `'` with something other than a space before it and nothing but
  // punctuation after it, up to the next space or quote. So neither an apostrophe nor a quote that opens a word closes
  // one, whatever opened it.
  it.each([
    ["user 'alice's cart' not found", "user ? not found"],
    // After punctuation too, and after nothing at all: anything but a space before it.
    ["invalid name '(alice smith)' given", "invalid name ? given"],
    ["invalid name '' given", "invalid name ? given"],
    // MySQL's own shape: punctuation after it, and then another quote.
    [
      "Access denied for user 'alice'@'localhost' (using password: YES)",
      "Access denied for user ?@? (using password: YES)",
    ],
    // A quote glued to the word after it does not close there, and the word goes with it, in any script: Turkish glues
    // a suffix to a name with an apostrophe, and `ı` is a letter.
    ["user 'alice'smith not found", "user ?"],
    ["kullanıcı 'Burak'ı bulamadı", "kullanıcı ?"],
    // A stray `'` opens a span, and the quote that opens the value does not close it: not after a space, and not after
    // punctuation when the value begins with punctuation too.
    ["can't trim the users' name ' alice smith'", "can't trim the users?"],
    ["user O'Neil has no handle ('@alice smith')", "user O?)"],
  ])("closes where a word ends: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // An apostrophe is one `'` more than the quotes, so a count would not say which `'` is left over: nothing is counted,
  // and a quote left open takes the rest of the message, whatever came before it.
  it.each([
    ["can't find user 'alice smith", "can't find user ?"],
    ["user 'alice' can't", "user ? can't"],
  ])("counts nothing: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  // The typographic `’` is both as well, and the `‘…’` span closes where it closes for the ASCII `'`: where a word
  // ends (gh-743, ADR 0192). A `’` between two letters is the apostrophe of `it’s` and the span goes on; one at the
  // end of a word closes it. `’` opens nothing, as ADR 0170 kept it, so there is no apostrophe to read it by and no
  // contraction list to carry: the end of the word is the only thing the rule reads.
  it.each([
    // The ticket's rows, measured on `origin/main` before the change: the words after the apostrophe left.
    ["user ‘it’s alice smith’ not found", "user ? not found"],
    ["user ‘alice’s cart’ not found", "user ? not found"],
    // A span that carries no `’` inside it closes exactly where it did before: nothing else of the family moves.
    ["user ‘alice smith’ not found", "user ? not found"],
    ["user ‚it’s alice smith‘ not found", "user ? not found"],
    // After punctuation too, and nothing but punctuation after it, up to the next space or a mark of the family.
    ["invalid name ‘(alice smith)’ given", "invalid name ? given"],
    [
      "Access denied for user ‘alice’@‘localhost’ (using password: YES)",
      "Access denied for user ?@? (using password: YES)",
    ],
    // A quote glued to the word after it does not close there, and the word goes with it, as for the ASCII `'`.
    ["user ‘alice’smith not found", "user ?"],
    // The plural possessive closes early: a value that carries a word-end `’` inside it leaves the words after it.
    // The cost the decision accepts, pinned here so it is not discovered later (ADR 0192).
    ["the ‘users’ cart’ was empty", "the ? cart’ was empty"],
    // And a quote left open takes the rest of the message, whatever apostrophes it carries.
    ["user ‘it’s alice smith", "user ?"],
  ])("closes the `‘…’` span where a word ends: «%s» comes out as «%s»", (message, sanitised) => {
    expect(sanitizeMessage(message)).toBe(sanitised);
  });

  it("keeps nothing of a `‘…’` value, whatever apostrophes stand around it or inside it", () => {
    // Every combination of what may stand before a value, what may open and close its quotes, what the value may be
    // and what may follow it, the typographic kind of ADR 0189's eleven thousand and three hundred forty: the
    // apostrophes are a contraction, a name, a possessive plural and an elision; the value may carry an apostrophe
    // in it and begin and end with punctuation; and its quote may be left open.
    const before = ["", "can’t find", "user’s", "CAN’T", "O’Neil", "the users’", "l’utilisateur"];
    const opening = [" ‘", " (‘", ": ‘", " name=‘", " x:‘", " [‘"];
    const values = [
      "alice smith",
      "it’s alice smith",
      "O’Brien smith",
      "@alice smith",
      "(alice smith)",
      "alice smith.",
    ];
    const closing = ["’ here", "’)", "’,", "’", "’.", "’; retry", ""];
    const after = ["", " can’t", " it’s", " users’", " O’Neil"];
    for (const b of before)
      for (const o of opening)
        for (const v of values)
          for (const c of closing)
            for (const a of after) {
              const message = `${b}${o}${v}${c}${a}`.trimStart();
              expect(sanitizeMessage(message), JSON.stringify(message)).not.toMatch(/alice|smith|Brien/);
            }
  });

  it("keeps nothing of a quoted value, whatever apostrophes stand around it or inside it", () => {
    // Every combination of what may stand before a value, what may open and close its quotes, what the value may be,
    // and what may follow it. The apostrophes are of every kind above: a contraction, a name, a possessive plural, an
    // elision and a leading one; the value may begin and end with punctuation; and its quote may be left open.
    const before = [
      "",
      "can't find",
      "user's",
      "CAN'T",
      "O'Neil",
      "the users'",
      "'til",
      "l'utilisateur",
      "rock 'n' roll",
    ];
    const opening = [" '", " ('", ": '", " name='", " x:'", " ['"];
    const values = ["alice smith", "alice's cart", "O'Brien smith", "@alice smith", "(alice smith)", "alice smith."];
    const closing = ["' here", "')", "',", "'", "'.", "'; retry", ""];
    const after = ["", " can't", " it's", " users'", " O'Neil"];
    for (const b of before)
      for (const o of opening)
        for (const v of values)
          for (const c of closing)
            for (const a of after) {
              const message = `${b}${o}${v}${c}${a}`.trimStart();
              expect(sanitizeMessage(message), JSON.stringify(message)).not.toMatch(/alice|smith|Brien/);
            }
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
/** And the quotes, which a sentence goes through first: as they were, and as they are on ASCII with no backtick. */
const QUOTES_BEFORE_GH_684 = BEFORE_GH_684.slice(0, 2);

/**
 * Whether a word of the message has a `/` or a `\` in it and something besides: the shape gh-697 added a rule for.
 *
 * Written with a split on spaces and not with that rule, so that it bounds what the rule may touch instead of copying
 * it. A slash on its own is not one, and it stays in the corpus, where the rule for a path has to leave it be.
 */
const hasPathWord = (message: string): boolean =>
  message.split(/\s+/).some((word) => /[/\\]/.test(word) && /[^/\\]/.test(word));

/**
 * Whether the message names a special scheme with its colon: the shape gh-713 read a URL with no slashes in.
 *
 * Any of the six names, whatever precedes it and whatever follows its colon, so that it bounds what the rule may touch
 * instead of copying where the rule decides a scheme begins.
 */
const hasSpecialScheme = (message: string): boolean => /(?:https?|wss?|ftp|file):/i.test(message);

/**
 * Whether a word of the message has a `?` in it with a letter, a digit or an `_` after it: the shape gh-720 added a rule
 * for.
 *
 * Asked of the message as written, which is how a name reaches that rule, and once its quotes are read, which is how a
 * sentence does: a closed quote glued to a word leaves a `?` with a letter after it (`'alice'user`), and that word goes
 * too. Written with a split on spaces and not with that rule, so that it bounds what the rule may touch instead of
 * copying it; and a `?` with nothing but punctuation after it is not one, so it stays in the corpus, where the rule has
 * to leave it be.
 */
const hasQueryWord = (message: string): boolean => {
  const quotesRead = QUOTES_BEFORE_GH_684.reduce((out, rule) => out.replace(rule, "?"), message);
  return [message, quotesRead].some((text) => text.split(/\s+/).some((word) => /\?.*\w/.test(word)));
};

/**
 * Whether a word of the message has a `#` with something before it and a letter, a digit or an `_` after it: the
 * shape gh-733 added a rule for.
 *
 * Asked of the message as written and once its quotes are read, as the query is, and written with a split on spaces
 * and not with that rule, so that it bounds what the rule may touch instead of copying it. A `#` at the start of a
 * word — a private field, a ticket, a channel — and one with nothing after it — a language's name — are not one, so
 * they stay in the corpus, where the rule has to leave them be.
 */
const hasFragmentWord = (message: string): boolean => {
  const quotesRead = QUOTES_BEFORE_GH_684.reduce((out, rule) => out.replace(rule, "?"), message);
  return [message, quotesRead].some((text) => text.split(/\s+/).some((word) => /.\S*#\S*\w/.test(word)));
};

/**
 * Whether the message has a `'` that the rule of gh-732 may read otherwise than the old one: one with a word character
 * on both sides, which may be an apostrophe, or one at which the old rule closed a span though a space came before it or
 * a word character came after it, before the next space or `'`.
 *
 * Written from the old rule's own pairing, which closed a span at every second `'`, and not with the new rule, so that
 * it bounds what the new rule may touch instead of copying it. A quote that opens after a space or punctuation and closes
 * before them is not one, so it stays in the corpus, where the new rule has to read it as the old one did.
 */
const hasQuoteOffAWordEdge = (message: string): boolean =>
  [...message.matchAll(/'/g)].some(({ index }, i) => {
    const before = message[index - 1] ?? "";
    const after = message.slice(index + 1);
    if (/\w/.test(before) && /^\w/.test(after)) return true;
    return i % 2 === 1 && (/\s/.test(before) || /^[^\s']*\w/.test(after));
  });

/**
 * Messages made only of ASCII, with none of the seven ASCII shapes a rule was added for since: a backtick and `://`
 * (gh-684), a word with a `/` or a `\` in it (gh-697), a special scheme's name and colon (gh-713), a word with a `?`
 * and a letter, a digit or an `_` after it (gh-720), a word with a `#` that has something before it and a word
 * character after it (gh-733), and a `'` inside a word or one the old rule closed off the end of a word (gh-732).
 * Those seven are the exceptions, and the only ones: a message that carries one changes identity once, by design and
 * said in the changeset (ADR 0170, ADR 0175, ADR 0180, ADR 0184, ADR 0189, ADR 0193).
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
    const exception =
      message.includes("`") ||
      message.includes("://") ||
      hasPathWord(message) ||
      hasSpecialScheme(message) ||
      hasQueryWord(message) ||
      hasFragmentWord(message) ||
      hasQuoteOffAWordEdge(message);
    if (!exception) messages.push(message);
  }
  return messages;
}

describe("what an upgrade leaves where it was", () => {
  const messages = asciiMessages(5000);

  it("is every message made only of ASCII with no backtick, no `://`, no word with a `/` or `\\` in it, no special scheme's name and colon, no word with a `?` and a letter, a digit or an `_` after it, no word with a `#` that has something before it and a word character after it, and no `'` inside a word or closed off the end of one: it comes out as it did before gh-684", () => {
    for (const message of messages) {
      expect(sanitizeMessage(message), `«${message}» as a message`).toBe(sanitizeWith(message, BEFORE_GH_684));
      expect(sanitizeValues(message), `«${message}» as a name`).toBe(sanitizeWith(message, VALUES_BEFORE_GH_684));
    }
  });

  it("keeps the slash on its own among them, where the rule for a path has to leave it be", () => {
    // Or the exception above could be hiding every slash, and the test passing on messages that have none.
    const alone = messages.filter((m) => m.split(/\s+/).some((word) => word === "/" || word === "\\"));
    expect(alone.length).toBeGreaterThan(100);
  });

  it("keeps the `?` with nothing but punctuation after it among them, on its own and at the end of a word", () => {
    // Or the exception for a query could be hiding every `?`, and the rule for one never asked to leave them be.
    const words = messages.flatMap((m) => m.split(/\s+/));
    expect(words.filter((word) => word === "?").length).toBeGreaterThan(100);
    expect(words.filter((word) => word.length > 1 && word.endsWith("?")).length).toBeGreaterThan(100);
  });

  it("keeps the quote closed at the end of a word among them, and the one left open", () => {
    // Or the exception for a `'` could be hiding every quote but one never closed, and the rule for `'` never asked to
    // close a span where the old one did.
    const quotes = messages.map((m) => m.split("'").length - 1);
    expect(quotes.filter((count) => count >= 2).length).toBeGreaterThan(100);
    expect(quotes.filter((count) => count % 2 === 1).length).toBeGreaterThan(100);
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
