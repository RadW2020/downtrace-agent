# 0193 — A fragment with no URL around it goes with its word

Estado: aceptado · Fecha: 2026-09-27 · Alcance: público

## Context (gh-733)

The URL rule in `packages/agent/src/sanitize.ts` (ADR 0170, ADR 0180) takes the fragment of a URL whose authority it
reads, the path rule (ADR 0175) the one of a word with a `/` or a `\`, and the query rule (ADR 0184) the one that
follows a `?`. A fragment that follows none of the three is read by no rule and leaves whole. Measured on
`origin/main` with `sanitizeMessage`:

| message | came out |
|---|---|
| `GET api.example.com#alice failed` | as it is |
| `open sms:ops#alice` | as it is |

For Node 26.8.1's parser the second is a URL with a fragment — `new URL("sms:ops#alice").hash` is `#alice` — and the
first is one as a relative reference. That a real error message carries such a fragment is a hypothesis, not
something measured here.

The reason the rule did not enter with the query's, gh-720, is that V8 names a private field the same way:
`Cannot read private member #alice from an object whose class did not declare it`, measured in Node 26.8.1. That
`#name` is the name of a field, which is structure, and a rule that took any `#` with something after it would
change the signature of that error and take from it what it says.

## Decision

**1. A fragment is a `#` that sits inside a word — with a non-space before it — and has a letter, a digit or an `_`
after it, and the whole word goes.** As the query rule decided for a `?` (ADR 0184), whatever stands before the `#`
goes with it, because the part before it is a host or a scheme and the part after it is the value:

```
GET api.example.com#alice failed    →  GET ? failed
open sms:ops#alice                  →  open ?
```

The rule reads the word as a reference against a base, as the query's does: a word with no scheme in front is a
host with a fragment in it, and a scheme the URL standard does not call special, with no `//` after it, is read as
a URL all the same.

**2. What is not a fragment keeps its words, because they are structure.** A `#` at the start of a word is how V8
names a private member, and how a ticket or a channel is named: `#alice` stays, and the error that names a private
field comes out as it is, with the name of the field in it, because that name is the structure the message is
about. A `#` with nothing after it is how a language is named: `C#` and `F#` stay, and a `#` at the end of a word,
on its own or before punctuation, is not a fragment either.

```
Cannot read private member #alice from an object whose class did not declare it    →  as it is
issue #alice is open                                                               →  as it is
the C# compiler failed                                                             →  as it is
```

**3. The cost is measured, pinned and said.** `Object#method` has the same shape as a fragment — a `#` inside a
word, with a word on either side — and no rule tells a method name after it from a value: it goes.

```
failed in Object#method    →  failed in ?
```

**4. Identity: the change is accepted, said, and pinned, as in ADR 0170, 0175, 0180, 0184 and 0189.** An error whose
message carries a word with a `#` that has something before it and a word character after it gets a new signature
after the upgrade, once, and is listed as a new error, newly observed, while the old one stops being seen. A message
made only of ASCII keeps its signature exactly unless it carries one of the shapes a rule was added for since, this
one among them, which the identity test of gh-684 now checks with a seventh exception beside the six it had, and the
cases that stay — a `#` at the start of a word, and one with nothing after it — are pinned in the test's own rows
and stay in the corpus, where the rule has to leave them be. The changeset and the README say so.

## Alternatives

**Take any `#` with something after it, whatever stands before it.** It is the rule that gh-720 refused: it takes
the name of a private field with it, changes the signature of every error V8 throws for one, and leaves that error
without the thing its message is about.

**Take nothing after a `#` that opens a word, and take only one inside a word.** That is the decision, and the
ticket's question is where the edge is: the edge is the start of the word, because that is where a name of a field,
a ticket or a channel opens, and where a fragment never does.

**Read the `#` by what stands after it alone — a value may not begin with a digit or punctuation.** It keeps `C#`
and `#name`, but it reads `api.example.com#4821` — a fragment that begins with a digit — as not a fragment, and a
digit after a `#` is the shape of a ticket number glued to a host, which is a value. The rule that took it before,
the one for digits, took only the number and left the host; this one takes the word, as the query rule does with a
number after a `?`.

## Consequences

- Two cases in `packages/agent/test/support/sanitiser-cases.ts`, one after a host with no scheme and one after a
  scheme with no `//`, and the gh-651 guard holds: each is decided by the new rule alone.
- A test that asks Node's parser, with each code point below 128 in each place of a fragment after each thing a
  fragment may follow with no URL rule to read it: wherever the parser reads the value in the fragment, the value
  may not come out.
- The identity test of gh-684 gains its seventh exception, asked of the message as written and once its quotes are
  read, as the query's is.
- `sanitizeValues` reads the same rule, so a context value that carries a fragment of this shape goes whole as a
  message does.
- What already left with these shapes in it stays in the cloud until the cloud forgets it. Nothing here removes it.
