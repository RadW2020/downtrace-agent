# 0189 — An apostrophe opens no quote, and a quote closes where a word ends

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-732)

`src/sanitize.ts` replaces whatever an error message puts between quotes, one rule per family of quotes (ADR 0170). The
rule for the ASCII `'` was `'[^']*'?`. It opened a span at any `'` and closed it at the next one. An apostrophe is a `'`
too, so the `'` of `can't` opened a span, and that span closed on the opening quote of the value after it. The value's
closing quote then opened another span. The value sat between the two and left. ADR 0170 kept the typographic `’` from
opening anything, but the ASCII one still did. Measured on `1584f72` with `sanitizeMessage`:

| message | came out |
|---|---|
| `can't find user 'alice'` | `?` |
| `user's 'alice' missing` | `?` |
| `Can't find user 'alice smith' here` | `? smith?` |
| `can't reach the server` | `can?` |
| `user 'O'Brien smith' not found` | `user ? smith?` |
| `the users' 'alice smith' list` | `the ? smith?` |

The first two went only because the rule for a query (ADR 0184) took the word the two spans had left, `can?alice?`. The
third still left what followed the space. The fourth is the price of the same reading, paid in text, and real messages
pay it: Prisma 7.7.0 builds `Can't reach database server at ${host}:${port}` (read in its `runtime/client.js`), and
mysql2 3.15.3 throws `Can't add new command when connection is in closed state`. Both travelled as `Can?`, which tells a
reader nothing (ERR-01). The last two are the same pairing seen from other sides: a span that closed at an apostrophe
inside the value, and one that a possessive plural opened before it. MySQL's own server messages, which mysql2 passes
on as the error's message, have the ticket's shape (`Can't create database '%s'; database exists`); that comes from
MySQL's published error reference and was not measured here.

## Decision

The ASCII `'` is both a quote and an apostrophe, so the rule reads each `'` by what stands on either side of it.

**1. An apostrophe is the `'` of an English contraction or possessive, and it opens nothing.** That is a `'` with a
letter, a mark, a digit or an `_` before it, and after it one of `t`, `s`, `d`, `m`, `re`, `ve` or `ll` that ends the
word, in either case: `can't`, `user's`, `I'd`, `I'm`, `you're`, `I've`, `it'll`, `CAN'T`, `José's`.

The ticket asked whether it should be any `'` between two letters, as `’` is. That reading lets a quote glued to a word
through as an apostrophe: `user'alice smith not found`, `user'alice'smith`, `near E'alice smith'` and `b'alice'`. They
have the same shape as a name with an apostrophe in it (`O'Brien smith`), and no rule can let one through and not the
other. The ending of a contraction is the one thing that tells an apostrophe apart, and what it could hide is one or two
fixed letters, never a customer's value.

So every other `'` still opens a span, and that includes one inside a word:

- `user O'Brien not found` still comes out as `user O?`, and `user'alice' not found` as `user? not found`;
- an elision (`l'utilisateur`), a leading apostrophe (`'til`) and a possessive plural (`users'`) still open one too.

They cost the text after them, as they did, and not a value.

**2. A quote closes where a word ends.** That is a `'` with something other than a space before it, and nothing after it
but punctuation, up to the next space or `'`:

```
Can't find user 'alice smith' here                  →  Can't find user ? here
user 'O'Brien smith' not found                      →  user ? not found
Access denied for user 'alice'@'localhost' (…)      →  Access denied for user ?@? (…)
the users' '@alice smith' handle is taken           →  the users? handle is taken
```

So an apostrophe never closes a span, and neither does a quote that opens a word, whatever opened the span before it.
The rule does not only ask for «no letter right after it», because a value may begin with punctuation (`'@alice'`,
`'(alice)'`). Its opening quote would then close a span that a name or a possessive plural had opened before it, and
the value would be left out. It stops at the next `'` for MySQL's `'alice'@'localhost'`, which it reads as it always
did.

**3. An odd number of quotes means nothing.** The rule never counts them. A message with a contraction in it has one
more `'` than it has quotes, and a quote left open still takes the rest of the message: `can't find user 'alice smith`
→ `can't find user ?`. Parity could not say which `'` is the one left over, since `can't find user 'alice smith` and
`user'alice' not found` both have two.

**4. Identity: the change is accepted, said, and pinned, as in ADR 0170, 0175, 0180 and 0184.** An error whose message
carries an apostrophe, or a quote the old rule closed where the new one does not, gets a new signature after the
upgrade, once. The cloud lists it as a new error, newly observed, and the old one stops being seen. The ones with a value
in them were mostly one error per value (`can?alice?` and `can?bob?`), and they now group. The changeset and the README
say so.

The frozen-rules test of ADR 0170 names a sixth exception, written from the old rule's own pairing (it closed a span at
every second `'`) and not from the new rule, so that it bounds the new rule instead of copying it. The exception is a
`'` with a word character on both sides, or a `'` at which the old rule closed a span though a space came before it or
a word character came after it, before the next space or `'`. Of the messages the seeded generator makes on its way to
5000, it leaves out 713 that no earlier exception did. A new check keeps more than a hundred messages with a closed
quote, and more than a hundred with one left open, among those that remain.

`sanitizeValues` reads no quotes, so a quoted SQL identifier keeps its label.

## Alternatives

**Any `'` between two word characters is an apostrophe** (the ticket's question). It reads every apostrophe, names
included, and keeps the most text. It also reads a quote glued to a word as an apostrophe. A generator written for this
ADR, not kept, built 60,000 messages to be hostile: every mix of contractions, names, elisions, possessive plurals and
leading apostrophes around one or two quoted values, with quotes glued to words on either side, values that begin and
end with punctuation, and quotes left open. Its values were kept free of a quote of their own and of a leading space.
The old rule let a value out of 7,215 of them, and the rule of this ADR out of none. This reading let one out of 19,891
where the old rule had not. With a second rule that pairs an apostrophe with a closing quote after it, it still let one
out of 10,021, because a glued quote left open, and one glued on both sides with a space inside, stay the same shape as
`O'Brien smith`.

**Only move where a quote closes, and let every `'` open as before.** It fixes the leak with the fewest identity
changes, but `can't reach the server` still travels as `can?`, and so do Prisma's and mysql2's messages.

**Reading parity**: when the quotes left once the apostrophes are set aside are odd, fall back to the old pairing, or
take everything from the first `'`. Parity does not say which `'` is left over (decision 3), and the old pairing is the
one that leaked.

**Closing at any `'` with no word character right after it.** It lets out a value that begins with punctuation after a
stray `'`: `O'Neil ('@alice smith')` came out as `? smith?`. On a set of 30 message templates of the shapes above, each
with 10 values, it let 9 out, and the rule of this ADR none.

**Reading other languages' apostrophes, the French elision first.** They cost text today, and would keep costing it.
Each would need its own list of what cannot hide a value, and no message of the pilot has shown one.

## Consequences

- Two cases of the rule for `'` in `test/support/sanitiser-cases.ts`: the ticket's shape, and a quoted value with an
  apostrophe inside it. The gh-651 guard holds, and every rule but the UUID one stands alone between a value and the
  wire.
- A test that asks every combination of what may stand before a quoted value, what may open and close its quotes, what
  the value may be and what may follow it: 11,340 messages, none of which may let the value out.
- On the 30 templates of the alternatives, each with 10 values, the old rule let 62 values out and this one none, and
  the words around the values that travel went from 695 to 1,380 of 1,520.
- Twenty-five mutations of the rule were each run against the agent's suite, and twenty-four turn it red:
  - the rule as it was;
  - every `'` opening, or none inside a word;
  - no capitals;
  - a quote that must close;
  - skipping only a `'` with a word character after it;
  - each of the seven endings taken out;
  - an ending with no word character before it, or not ending the word;
  - the class before an ending or after a closing quote read as ASCII;
  - a closing quote after a space, or only after a word character;
  - looking only at the character after a closing quote, not stopping at a quote, not stopping at a space, or not
    looking at all;
  - the rule moved after the one for `"`.

  Three survived the first run and are covered now: the two ASCII classes and the word character before a closing
  quote. The one that stays green reads the ending `t` only after an `n`. English has no other, so on English the two
  are the same rule.
- What it costs. A value that begins with a space, after a `'` that opened a span (`users' name=' alice smith'`), still
  leaves, since its opening quote reads as a closing one; it left before too. So does a quote inside a quoted value at
  the edge of one of its words (`'alice' smith'`), where one mark for both leaves no reading that tells which is which.
  And a quote glued to the word after it no longer closes there, so `user 'alice'smith not found` comes out as `user ?`
  and not as `user ? not found`.
- The typographic `’` still closes a `‘…’` span, so `user ‘it’s alice smith’ not found` comes out as
  `user ? alice smith’ not found`. It is the same question asked of another rule, whose identities it moves, and it has
  its own ticket, gh-743.
- What already left with these shapes in it stays in the cloud until the cloud forgets it. Nothing here removes it.
