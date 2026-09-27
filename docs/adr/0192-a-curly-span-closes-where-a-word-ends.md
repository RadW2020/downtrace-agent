# 0192 — A curly span closes where a word ends, and an apostrophe inside it does not end it

Estado: aceptado · Fecha: 2026-09-26 · Alcance: público

## Context (gh-743)

The rule for the `‘…’` family of quotes in `packages/agent/src/sanitize.ts` was `/[‘‚][^‘’]*[‘’]?/g` (ADR 0170): it
opens a span at `‘` or `‚` and stops its content at either mark. ADR 0170 kept the typographic `’` from opening
anything, because it is also the apostrophe of `can’t`, but it still closed the span. So an apostrophe inside a
quoted value closed the span, and whatever stood after it left the server. Measured on `origin/main` with
`sanitizeMessage`:

| message | came out |
|---|---|
| `user ‘it’s alice smith’ not found` | `user ? alice smith’ not found` |
| `user ‘alice’s cart’ not found` | `user ? cart’ not found` |
| `user ‘alice smith’ not found` | `user ? not found` |

ADR 0189 read the ASCII `'` by what stands on either side of it — the apostrophe of an English contraction or
possessive opens nothing, and a quote closes only where a word ends — and left this rule to its own ticket, this
one, because the identities it moves are the ticket's to decide. A message of a library that puts a typographic
apostrophe inside a typographic quote is a hypothesis, not something measured here: in the messages of Node's
libraries they are rare, and they appear more in the ones a person writes or an editor rewrites.

## Decision

**1. A `’` closes a `‘…’` span only where a word ends.** That is a `’` with something other than a space before it,
and nothing after it but punctuation, up to the next space or a mark of the family (`‘` or `’`):

```
user ‘it’s alice smith’ not found                  →  user ? not found
user ‘alice’s cart’ not found                      →  user ? not found
invalid name ‘(alice smith)’ given                 →  invalid name ? given
Access denied for user ‘alice’@‘localhost’ (…)     →  Access denied for user ?@? (…)
```

The scan stops at a mark of the family as well as at a space, for the same reason ADR 0189's stops at a `'`:
`‘a’‘b’` is two spans, and a `’` before the `‘` of the second must close the first, or the second value opens where
the first one is still open and the words between the marks leave.

**2. A `’` with a word character after it does not close the span.** That is the apostrophe of `it’s`, and the quote
glued to the word after it, which ADR 0189 reads the same way for the ASCII `'`: a span goes on to the next word-end
`’`, a `‘`, or the end of the message, which it takes whole, as an unterminated one does:

```
user ‘alice’smith not found    →  user ?
user ‘it’s alice smith         →  user ?
```

**3. `’` opens nothing, and the family keeps its opens.** `‘` and `‚` still open the span, as ADR 0170 left them.
Because `’` never opens one, the rule needs no counterpart of the ASCII reading of an apostrophe and no contraction
list: the end of the word is the only thing it reads, and it is strictly safer than the ASCII rule, which also has
to decide what opens.

**4. The plural possessive closes early, and that cost is accepted, measured and pinned.** A value that carries a
word-end `’` of its own — the `’` of `users’` — closes the span at it, and the words after it leave:

```
the ‘users’ cart’ was empty    →  the ? cart’ was empty
```

It is the same shape ADR 0189 accepted for the ASCII `'`, a quote inside a quoted value at the edge of one of its
words, where one mark for both leaves no reading that tells which is which. The cost is a test, not a footnote: the
row is in `sanitize.test.ts`, and the README says it.

**5. Identity: the change is accepted, said, and pinned, as in ADR 0170, 0175, 0180, 0184 and 0189.** An error whose
message carries a `’` inside a `‘…’` span gets a new signature after the upgrade, once, and is listed as a new error,
newly observed, while the old one stops being seen. The ones that carried a value in them were mostly one error per
value anyway, and they now group. A span with no `’` inside it closes exactly where it did before, and a message
made only of ASCII keeps its signature exactly, which the identity test of gh-684 checks, since its corpus is ASCII
and needs no exception for this rule. The changeset and the README say so.

## Alternatives

**Keep the old rule, and close at every `’`.** It is what let the ticket's rows out, and it costs nothing to keep:
the reading of ADR 0189 is already paid for, and this one is the same reading one mark over.

**Never close at `’`: the span ends at a `‘` or at the end of the message.** It fixes the leak and moves no identity
that the old rule did not move, but it over-erases and leaks in the other direction. `user ‘alice’ ‘bob’ here`
becomes `user ? bob’ here`, because the second span opens inside the first: the `’` after `alice` no longer ends it,
the `‘` after the space does, and `bob` stands between a mark that does not close and one that opens. The span takes
the rest of the message in every case, which is what an unterminated quote already does, and a message that comes
out mostly `?` is the one `product.md:104` omits rather than risks.

**Read the `’` by a contraction list, as the ASCII `'` is read.** The list exists for the ASCII rule because every
`'` that is not an apostrophe opens a span, and the rule has to say which ones do not open. A `’` opens nothing, so
there is nothing to set aside: asking only where the span ends reads every case the list would read, and not one the
list would not.

## Consequences

- One case in `packages/agent/test/support/sanitiser-cases.ts`, the ticket's row, and the gh-651 guard holds: it is
  decided by the `‘…’` rule alone.
- A test that asks every combination of what may stand before a `‘…’` value, what may open and close its quotes, what
  the value may be — with and without an apostrophe in it — and what may follow it: 8,820 messages, none of which may
  let a word of the value out.
- The README's list of what still leaves loses this row and gains the plural possessive, which is now the only shape
  of a `‘…’` span that leaves words after it.
- `sanitizeValues` reads no quotes, so a name with a `’` in it is not touched by this change.
- What already left with these shapes in it stays in the cloud until the cloud forgets it. Nothing here removes it.
