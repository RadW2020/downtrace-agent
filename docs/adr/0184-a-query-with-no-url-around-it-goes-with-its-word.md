# 0184 — A query with no URL around it goes with its word

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-720)

ADR 0170 gave a URL its rule in `src/sanitize.ts`, and ADR 0180 made it read an authority where Node's parser reads
one: after `://`, and after the colon of a special scheme. That rule takes the query of such a URL. ADR 0175 gave a
word with a `/` or a `\` in it its rule, and that rule takes the query with the path. A query that follows neither was
read by no rule. Measured on `d1af76d` with `sanitizeMessage`, each of these left the server whole:

- `GET api.example.com?name=alice failed` and `no handler for ?name=alice`;
- `open sms:ops?body=alice` and `open magnet:?xt=urn:btih:abc&dn=alice`;
- the query of `open mailto:ops@cliente.com?subject=alice`, which came out as `open mailto:?subject=alice`, the email
  rule taking only the address;
- `request to https:<tab>api.example.com?name=alice failed`, which came out with its query. The parser removes the
  tab and reads `https:api.example.com?name=alice`, which ADR 0180 sanitises. The sanitiser reads the tab as the end
  of a word, and the word after it is the first shape.

The middle three are URLs to Node 26.8.1's parser. Their schemes are not special and have no `//` after them, so the
URL has no host: `new URL("sms:ops?body=alice")` has `host` `""`, `pathname` `ops` and `search` `?body=alice`. The first
two are references that the parser resolves against a base, and it reads the same query in them. Whether a real error
message carries one of these shapes is a hypothesis. None was measured here.

## Decision

**1. A query with no URL around it is a `?` in a word with a letter, a digit or an `_` after it, somewhere in that word,
and no `/` or `\` before it.** The class is read in every script, as every pattern reads a word since ADR 0170. The
ticket offered two readings: «a `?` followed by something with a `=`», and «any `?` inside a word with something after
it». The parser sides with the second. To it, whatever follows a `?` is the query, so `?&name=alice`, `?)alice` and
`?alice` are queries too, and a rule that waited for a `=` would leave each value.

But «anything after it» is too wide. It would take `(?,?,?)`, placeholders written without spaces, which today travel
as `(?)`. It would also take `null?)`, where the `?` is prose. What every query with a value in it has is a letter, a
digit or an `_` somewhere after the `?`, since that is what a value is made of. So these stay, as the ticket requires:

- a `?` at the end of a word (`unexpected token?`);
- a `?` on its own, which is what the sanitiser itself leaves;
- a `?` with nothing but punctuation after it (`(?,?,?)`, `null?).`).

A query after a `/` or a `\` stays the path rule's, which takes the word whole already. Keeping the two rules apart
is what lets each one decide a case of its own (ADR 0167).

**2. Nothing of the word stays.**

```
GET api.example.com?name=alice failed        →  GET ? failed
no handler for ?name=alice                   →  no handler for ?
open mailto:ops@cliente.com?subject=alice    →  open ?
```

ADR 0175 took a host with no scheme whole with its path. Without a scheme, nothing says that `api.example.com` is a
host and `ana.perez` is not. A query does not change that.

**3. The query of a scheme that is not special is this rule's, and the scheme goes with it.** The URL rule reads an
authority and keeps a host. A scheme that is not special, with no `//` after it, has neither. What the parser reads
there is a path (`ops`, `ops@cliente.com`), and a path is a name like any segment (ADR 0175). And to the parser a
scheme is any word followed by a colon: `status:` and `alice:` are schemes as much as `sms:` is. Keeping the scheme
would keep whatever word stood before a colon. So one rule, blind to what stands before the `?`, reads all three
shapes: a host with no scheme, nothing at all, and any scheme the URL rule does not read.

**4. Where it runs.** It is a value pattern, so it runs after the quotes, and it has two more constraints:

- **After the URL rule.** That rule puts a `?` of its own in place of whatever followed a URL's `?`, so the query rule
  finds nothing to read there. Run first, the query rule would take the host of `https:api.example.com?name=alice`
  along with the rest.
- **Before the email, the UUID, the long run and the digit rule.** Each of those leaves a `?` glued to whatever
  followed its value, and this rule would read that as a query. `x9-alice` would come out as `?` and not as `?-alice`,
  and the identity of messages with no `?` in them would move.

Reading a sentence after its quotes has a consequence. A closed quote glued to a word leaves a `?` with a letter after
it, so `user 'alice'smith not found` comes out as `user ? not found`, where it used to be `user ?smith not found`. It
is ADR 0083's trade: a false positive costs a `?`.

It also takes a value that an ASCII apostrophe had left between two quotes. `can't find user 'alice'` came out as
`can?alice?`: the `'` of `can't` closed on the opening quote of the value, and the closing quote opened a span of its
own. That now goes whole. A quoted value with a space in it still leaves what follows the space. That is the quotes'
gap and not this rule's, and it has its own ticket, gh-732.

**5. Identity: the change is accepted, said, and pinned, as in ADR 0170, 0175 and 0180.** An error whose message carried
this shape gets a new signature after the upgrade, once. The cloud lists it as a new error, newly observed, and the old
one stops being seen. Most of these were one error per value. The changeset and the README say so.

The frozen-rules test of ADR 0170 names a fifth exception: a word with a `?` in it and a letter, a digit or an `_` after
it. The rule reads a quoted SQL identifier as written and a sentence after its quotes, so the exception is asked of the
message both ways, once as written and once after the frozen quote rules. It is written with a split on spaces, not
with the rule, so it bounds the rule instead of copying it. Of the messages the seeded generator makes on its way to
5000, it excludes 798. A new check keeps more than a hundred `?` on their own, and more than a hundred at the end of a
word, among those that remain, where the rule has to leave them be.

## Alternatives

**A query needs a `=`** (the ticket's first reading). It keeps any word with a `?` and no `=` in it, but it leaves the
value of `?alice` and of `?&name=alice`, and the parser reads both as queries.

**Any `?` with something after it** (the ticket's second reading, taken literally). It takes `(?,?,?)` and `null?)`,
and moves the identity of every message with placeholders or prose written that way.

**A letter, a digit or an `_` right after the `?`.** It keeps `?&name=alice`, `??name=alice` and `?)alice` whole. The
test that asks the parser finds that on the first code point that is punctuation.

**Keeping the host, or the scheme.** Nothing says either is a host or a scheme: `ana.perez?x=1` and `alice:x?y=1` read
the same as `api.example.com?x=1` and `sms:ops?x=1`. ADR 0170 keeps a host because a scheme with an authority says it is
one. Neither shape here has that.

**The URL rule reading a scheme that is not special with no `//`.** It would have to keep a scheme that is any word with
a colon, and read an opaque path as something. Every `key:value` in a message would then be a URL.

**Running the rule before the quotes**, so that it read only the `?` of the message as written. A query that opened a
quoted span would take the opening quote with it, and the closing quote would then open a span of its own: in
`'?q=alice smith'`, `smith` would be left outside both. The quotes run first for the reason ADR 0175 gives for a path.

## Consequences

- One more value pattern, with six cases of its own in `test/support/sanitiser-cases.ts`: a host with no scheme and a
  query, a query alone, a scheme that is not special with a path, with none, and with an address, and the word after a
  tab. The gh-651 guard holds, and every rule but the UUID one stands alone between a value and the wire.
- A test that asks Node's parser, not a list written by hand. Each ASCII code point that does not end a word is put in
  three places of a query: right after the `?`, between a parameter's name and its value, and right before the `?`.
  Each is tried after a host with no scheme, after nothing, and after four schemes that are not special. Wherever the
  parser reads the value in the query, as a URL or as a reference against a base, the value may not come out.
  Whitespace is left out: to the sanitiser it ends a word, as it ends a path (ADR 0175).
- Nineteen mutations of the rule were each run against the agent's suite, and seventeen turn it red:
  - taking the rule out;
  - moving it before the URL rule, or after the email, the UUID, the long run or the digit rule;
  - reading only a word character right after the `?`, or anything after it;
  - reading a query after a separator, after a `/` or after a `\`;
  - reading the class after the `?` as ASCII, as letters, or as letters and digits;
  - taking only the word up to its `?`, or only from it;
  - waiting for a `=`.

  Four survived the first run and are covered now: the query after a `\` and the three narrower classes. The two that
  stay green are equivalent:
  - moving the rule before the rule for a path, since each of the two takes whole words, and a word that either of
    them takes goes whole whichever runs first;
  - reading from anywhere in a word rather than from its start, since the rule for a path runs first and has already
    taken every word with a separator in it, which is the only word where the two readings differ.
- A fragment with no URL around it (`api.example.com#alice`, `sms:ops#alice`) still leaves whole. V8 names a private
  field the same way (`Cannot read private member #name …`), so it is a decision of its own, and it has its own ticket,
  gh-733.
- A tab or a newline inside a URL is still the end of a word everywhere else, as ADR 0180 left it.
- What already left with this shape in it stays in the cloud until the cloud forgets it. Nothing here removes it.
