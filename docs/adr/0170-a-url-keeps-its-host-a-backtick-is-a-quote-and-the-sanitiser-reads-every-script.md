# 0170 — A URL keeps its host, a backtick is a quote, and the sanitiser reads every script

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-684)

gh-651 gave each rule of `src/sanitize.ts` a case that only it decides (ADR 0167), and looking for those cases
turned up value shapes that no rule caught at all. Measured on `619abc5`, each of these left an error message, a
context value of `captureException` and a quoted SQL identifier whole:

- the path and query of a URL, and half of its userinfo: `postgres://payroll:hunter@db.internal/orders` came out
  as `postgres://payroll:?/orders`, the email rule taking the password and the host and leaving the user. It is
  not a made-up message: `node-fetch` 2.7.0 builds `request to ${request.url} failed, reason: …` and three other
  messages with the URL in them;
- quotes that are not `'` or `"`: `“…”`, `„…“`, `‘…’`, `‚…‘`, `«…»`, `»…«`, `「…」`, and backticks;
- digits outside ASCII (`４８２１`, `٤٨٢١`), emails outside ASCII (`josé@cliente.com`, `ana@müller.de`, and an
  accent written as a combining mark), and a long run with an accent in it (`álvaro_garcía_marketing`), which the
  long-run rule cut at each accent into pieces too short to catch.

The last three have one cause. The patterns read `\w`, `\d` and `\b`, and JavaScript keeps those ASCII even with
the `u` flag.

Every fix changes the sanitised text of the messages that carry the shape, and an error's identity is the hash of
that text (ADR 0083). The cloud keys an error by it. So the fix could not be made without deciding what happens to
those identities, and that is why ADR 0167 left it here.

## Decision

**1. A URL keeps its scheme, and its host and port when the authority is nothing else.** The path, the query and
the fragment go, because invariant 5's parameters are in them. The host stays because it is the shape a dependency
target already travels in (`src/instrument/http.ts` sends `URL.host`), and ADR 0090 already reads a host as
structural metadata. So a host in a message adds no category of data that does not leave already. It is still
read by the other rules, so a host with a digit or a long run in it loses that part, as any word does.

An authority that is anything but a host and a port takes the whole URL after the scheme with it. That covers a
user and a password, a password with a `/` in it, a port that is not digits, and an IPv6 literal. A rule that tried
to find where a credential ends would get it wrong on exactly the malformed ones.

```
request to https://api.example.com/users/alice?name=alice failed   →  request to https://api.example.com/? failed
could not connect to postgres://payroll:hunter@db.internal/orders  →  could not connect to postgres://?
```

The URL rule is a value pattern, and it runs first, before the email rule, which would otherwise take the password
and the host and leave the user.

**2. A backtick is a quote.** Its span is replaced, closed or not, as `'` and `"` are. Prisma and MySQL name a
field with it, so ``Unique constraint failed on the fields: (`email`)`` comes out as `… on the fields: (?)`, and
that is a loss. But other libraries put values between backticks (``Expected `alice` to be a number``), and the
quote rules already make this same trade for `relation "users" does not exist` (ADR 0083: a false positive costs a
`?`).

**3. One rule per family of quotes.** Each rule opens at any of its languages' opening marks and closes at either of
its marks:

- `“…”`, with `„…“` and `„…”`;
- `‘…’`, with `‚…‘`;
- `«…»` and `»…«`;
- `「…」` and `『…』`;
- backticks.

`’` does not open a span, because it is also the apostrophe of `can’t`.

**4. The patterns read letters, marks and digits of every script.** `\w` becomes `[\p{L}\p{M}\p{N}_]`, `\d`
becomes `\p{N}`, and `\b` becomes the same boundary written with lookarounds over that class. The class is written
once, and the email, the long run, the digit rule and the boundary are all built from it. The marks are in because a
name typed in decomposed form is an `e` followed by a combining accent, and a class without them cuts the name at
the accent. The UUID rule keeps its ASCII class and its `\b`, because a UUID is hex by definition.

The translation is mechanical, and that is what makes it checkable. On a message made only of ASCII, each pattern
is the pattern it was.

**5. Identity: the change is accepted, said, and pinned to these shapes.** An error whose message carried one of
these shapes gets a new signature after the upgrade. The cloud lists it as a new error, newly observed since
installation (ERR-01), and the old one stops being seen. The changeset and the README say so.

- **Most of those were not one error, but one per value.** `user “alice” not found` and `user “bob” not found`
  were two signatures. So what the upgrade does to them is the grouping the sanitiser exists for, arriving late.
- **What is lost is the triage.** A resolved error that happens again after the upgrade arrives as new, not as a
  reappearance (ERR-03). A change of code does the same today whenever it moves the line an error is thrown from,
  because the line is part of the identity.
- **Nothing else moves.** A message made only of ASCII, with no backtick and no `://` in it, comes out exactly as
  it did before. `sanitize.test.ts` checks this against the previous rules, frozen, over a seeded corpus built from
  pieces each old rule catches. A mistranslated pattern turns that test red and names the message.

Outside ASCII, a message changes only where a letter, a mark or a digit outside ASCII touches something a rule
reads. For example, `tabla_año_2024` used to come out as `tabla_añ?` and now comes out as `?`.

## Alternatives

**Dropping the host of a URL too.** It is simpler and safer, and it keeps one error per place when the same line
calls many hosts, a webhook sender for instance. But it hides from the reader which service failed, and the host
already leaves as the dependency's name. Keeping the host is what ADR 0090's reading of structure allows.

**Keeping a backtick span when its content looks like a name.** It would keep `` `email` ``, and it would also keep
`` `alice` ``, which is the case the rule is for.

**One rule for every quotation mark** (`\p{Quotation_Mark}`, or the `Pi` and `Pf` categories). It would be one
line, but it would stop `“it’s alice”` at the apostrophe and let `alice` out. It would also open a span at every
`can’t`. Not covered, and the README says so: `‹…›`, the fullwidth quotes and the other marks of that property. They
are rare in the error messages of a Node backend, and each one is one more family whenever it is needed.

**Normalising the message (NFKC) before sanitising.** It would turn `４８２１` into `4821`, so the ASCII rules
would catch it. But it would not touch `٤٨٢١` or `müller.de`, and it would rewrite text that travels, which moves
identities for no gain against invariant 5.

**Counting letters of every script in the half-the-words threshold** (ADR 0084). That rule decides what is omitted,
not what is a value. Counting every script would send text that is omitted today, which is a different decision
and belongs to a different ticket.

**Sending the previous hash beside the new one**, so that the cloud could join the two errors. The previous hash is
a hash of the unsanitised text, and a dictionary of first names reverses it.

**Hashing the old text and sending the new one.** It keeps the identities and breaks the property ADR 0083 chose:
the same hash always means the same text.

**Putting the new rules behind a switch.** It keeps the identities for whoever does not turn the switch on, and it
also keeps the leak open for them.

## Consequences

- Every new rule decides a case of its own in `test/support/sanitiser-cases.ts`, and the gh-651 guard holds with
  them. Thirty-nine mutations of the new rules were each run against the suite, and each turns it red: taking a
  rule out, reordering rules, a class back to ASCII, a boundary put back to `\b`, a length moved by one.
- `sanitizeValues` changes too, so a quoted SQL identifier with one of these shapes gets a new label, and with it a
  new query fingerprint. Two examples: `"tabla_año_2024"`, where a digit is glued to a letter outside ASCII, and
  `"Geschäftsführung"`, sixteen letters with two of them outside ASCII. Both now come out as `?`, as
  `"OrderItemsArchive"` already did. Such identifiers are rare, and the changeset names them with the error
  signatures.
- A path without a scheme (`no route for /users/alice`) and a file path in a message are still not recognised.
  They are a different shape, and they have their own ticket, gh-697.
- What already left with these shapes in it stays in the cloud until the cloud forgets it. Nothing here removes it.
