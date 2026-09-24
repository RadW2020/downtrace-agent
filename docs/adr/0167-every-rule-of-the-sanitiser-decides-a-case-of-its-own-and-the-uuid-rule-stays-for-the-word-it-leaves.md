# 0167 — Every rule of the sanitiser decides a case of its own, and the UUID rule stays for the word it leaves

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-651)

`src/sanitize.ts` holds the rules that decide which words of a message are values: two for quoted spans and four
value patterns (email, UUID, long run, digit), then a collapse and the half-the-words threshold of ADR 0084. The
same rules sanitise the message of every error the instrumentation signs, the values of the context of
`captureException`, and, without the quotes, a quoted SQL identifier and a context key (ADR 0090).

The ticket found that the quoted-span rule could be deleted with the suite green, and that `user 'alice' not found`
then left the server whole. Measured one mutation at a time over the whole agent suite, it was not alone. On
`6b6c126`, each of these left every test green:

- deleting either quote rule, or both;
- making either one require its closing quote;
- deleting the UUID rule, or the long run;
- running the email rule after the digit rule, or the UUID rule after the long run;
- dropping the whitespace collapse or the trim, or moving the threshold from a half to a third;
- sanitising a context value as a name instead of as prose.

The reason was the same every time. Each hostile message in the tests carried a digit or an email besides what it
was written for, so every rule was asked only together with the digit rule or the email rule, and those two caught
everything.

Looking for a case that only the UUID rule catches turned up a second fact: there is none. A UUID is 36 characters
of the long run's own class, `[0-9a-zA-Z_-]`, hyphens included. Wherever the UUID rule matches, the long run matches
the same characters or more, so no UUID survives without its rule. The comment beside it gave another reason: «so a
UUID is not eaten as three separate hex runs». That was never true, because the long run has taken hyphens since
both were written (`ac19643`). What the UUID rule does decide is the word glued to it. `lock order-<uuid> is held`
comes out as `lock order-? is held` with it, and as `lock ? is held` without it, because the long run takes
`order-` along with the UUID.

## Decision

**1. Every rule decides a case that no other rule does, and a test checks this from the source's own list.**
`sanitize.ts` exposes the list `sanitizeMessage` runs (`MESSAGE_RULES`), the list `sanitizeValues` runs
(`VALUE_PATTERNS`), and the loop both of them run (`sanitizeWith`). `sanitize.test.ts` takes each rule out of that
list in turn and runs the same loop without it. The rules whose absence changes what comes out of a case are the
ones that decide that case. The test requires three things:

- each case in `test/support/sanitiser-cases.ts` is decided by exactly one rule;
- each rule decides at least one case;
- each case comes out exactly as written in the table.

A rule added without a case of its own goes red, and the test names it. A case that a second rule starts deciding
goes red too, because either rule could then be deleted without anyone noticing. The tie between a rule and its case
is computed, never written down, so no copy of the rules exists to fall behind them.

**2. Every rule but one is the only thing between a case's value and the wire.** The one that is not is the UUID
rule, and the test says so. It checks that there is exactly one such rule, and that the case it decides has a UUID
for its value.

**3. The UUID rule stays**, for the word it leaves. Its comment now says that.

**4. The same table reaches every door a message leaves by.** It is run through the context of `captureException`
and through the bytes of a batch. The cases decided by a value pattern also go through `sanitizeValues`. A case is
added once and reaches all of them.

## Alternatives

**Deleting the UUID rule.** It is the simpler list, and invariant 5 loses nothing. But it changes the identity text,
and so the hash, of every error and every quoted identifier that carries a UUID glued to a word by a hyphen:
`order-<uuid>`, `tenant-<uuid>`. After an upgrade the cloud would see a new signature for each of them, a new error
where none began, in exchange for one regular expression fewer. A test-first ticket is the wrong place to spend a
change of identity, and the gain does not pay for it anyway.

**Keeping it, untested.** Then it is a rule that no test depends on, which is what this ticket was about.

**Checking that each case is "touched" by one rule only**, with `message.replace(rule)` and no loop. It needs only
the lists, not the loop, and it is order-independent. But it cannot express the UUID case, which three rules touch
and only one decides, and it cannot see order. Order is what keeps `ana4@cliente.com` whole for the email rule.

**Mutating the exported arrays inside the test.** It needs no new function, but it puts shared state that production
reads into a test's hands. A loop that takes its rules as an argument does the same job without that.

**Fixing, here, the shapes no rule catches.** A URL's path and query, quotes that are not ASCII's, backticks, and
digits and emails outside ASCII all leave whole today. Each fix changes what comes out of those messages, and each
needs its own decision. They are gh-684, and every rule that ticket adds will need its own case in the table.

## Consequences

- Each of the mutations listed above now turns at least one test red.
- `src/sanitize.ts` exports three things that are not part of the package's API. `index.ts` does not re-export them.
- The table is the place to add a case. The test decides which rule the case belongs to.
- The shapes the sanitiser still lets through whole are gh-684. A plain word outside quotes is not among them: no rule
  can recognise one, and the README already says so.
