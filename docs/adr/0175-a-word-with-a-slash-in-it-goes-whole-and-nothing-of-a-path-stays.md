# 0175 — A word with a slash in it goes whole, and nothing of a path stays

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-697)

ADR 0170 gave a URL its rule in `src/sanitize.ts`, and that rule reads only what follows `://`. A path with no scheme
in front of it, and a file path, were left to no rule at all. Measured on `3a0ca34` with `sanitizeMessage` and
`sanitizeContext({ reason })`, each of these left the server whole:

- `no route for /users/alice?name=alice`, and `GET api.example.com/users/alice failed`;
- `cannot read /home/alice/orders.csv`, `cannot read C:\Users\alice\orders.csv` and
  `cannot read uploads/alice/orders.csv`.

It is not made up, and Node writes it itself. Measured on Node 26.8.1, the ESM loader names the importing file by
its absolute path and without quotes: `Cannot find package 'left-pad-nope' imported from
/…/home/alice/app/index.mjs`. `net` does the same with a Unix socket: `connect ENOENT /tmp/nope-gh697.sock`. The
paths of `fs` errors are quoted, and those already went whole with their quotes. The reference app throws one as
well: `provider call /authorize failed after 3 attempt(s)`.

A segment of a path is a plain word, and a plain word is exactly what no rule can tell from a value (ADR 0083,
the README of `@downtrace/agent`). So the question was not which segments look like values, but how much of a path
may stay.

## Decision

**1. A path is a word with a `/` or a `\` in it and something else besides, and the whole word goes.** A word is a
run of characters between two spaces. One rule takes, with no list of roots, a path from the root (`/users/alice`),
one glued to the word in front of it (`GET:/users/alice`), a relative one (`uploads/alice/orders.csv`), a Windows
one (`C:\Users\alice\orders.csv`, `\\server\share`), a protocol-relative URL (`//cdn.example.com/alice`) and a
host with a path and no scheme. The query goes with the path, since it is part of the word.

```
no route for /users/alice?name=alice                      →  no route for ?
cannot read C:\Users\alice\orders.csv                     →  cannot read ?
Cannot find package 'x' imported from /home/alice/app/index.mjs  →  Cannot find package ? imported from ?
```

It leaves a `/` on its own, which is punctuation (`ord-99 / inv-12`), and a word whose first separator is the `//` of
a `://`, which is a URL and ADR 0170's rule's. A URL inside a path's query does not shield the path:
`/users/alice?next=https://app.example.com/home` goes whole.

**The cost.** A word that only joins two words with a slash goes too. libuv's `EIO: i/o error, read` comes out as
`EIO: ? error, read`; `Unsupported Media Type: application/xml` as `Unsupported Media Type: ?`, and that media type is
the value of a request header, which invariant 5 names anyway; llhttp's `Parse Error: Expected HTTP/` as
`Parse Error: Expected ?`. It is ADR 0083's trade: a false positive costs a `?`, and a false negative puts a
customer's name in a batch.

**A space ends a path.** Without quotes, nothing tells a space inside a path from a space between two words, so
`/home/alice/My Documents` leaves `? Documents`. Between quotes a path goes whole, space and all, because the quotes
are read first: that is how Node's `fs` names one. The README says so.

**2. Nothing of a path stays, its first segment included.** `/users/?` would read as structure, but the first
segment is a plain word as well: `/acme/settings` is a tenant, `/alice` is a handle, and `D:\clientes\acme\` is a
customer. The structure the reader needs travels anyway. The route template is the route the error is recorded
under, and the stack signature carries the file and the line.

**3. A host without a scheme goes with its path.** `GET api.example.com/users/alice failed` → `GET ? failed`. ADR 0170
keeps a host because the scheme says it is one, and because a dependency target travels in that shape. Without a
scheme, nothing says that `api.example.com` is a host and `ana.perez` is not. A host alone, with no separator after
it, is untouched, as it was: `getaddrinfo ENOTFOUND api.example.com`.

**4. It is a value pattern, and it reads neither the route nor the stack signature.** Being a value pattern, it also
reaches a quoted SQL identifier with a separator in it (ADR 0090). It sits after the URL rule, and its place among the
value patterns decides nothing, since it takes a whole word whatever the others left in it. It does run after the
quotes, and that matters for the reason given in decision 1.

The route never meets it. A route template (`/orders/:id`) is built by `src/routes.ts` and travels as the route of
the profile and of the aggregates, and no rule of `src/sanitize.ts` reads it. Nor does the stack signature, which
`src/errors.ts` builds apart from the message and appends after the message is sanitised. The signature keeps
`file:line` and a package name, `(@prisma/client)` with its `/` included. Two tests hold this: the bytes of a batch
carry the route as written beside errors whose paths they do not carry, and an error's text is its sanitised message
followed by exactly what `stackSignature` made of its stack.

Checking what the stack signature sends found a gap of its own. A directory with a parenthesis in it
(`Program Files (x86)`, `Copy (2)`) leaves the directory in the signature, because `frameOf` looks for the last `(`
of a frame. Fixing it moves the identity of every error thrown under such a directory, and it is not this rule, so
it has its own ticket, gh-712.

**5. Identity: the change is accepted, said, and pinned, as in ADR 0170.** An error whose message carried a word with
a `/` or a `\` in it gets a new signature after the upgrade, once. The cloud lists it as a new error, newly observed,
and the old one stops being seen. Most were one error per path (`no route for /users/alice` and `/users/bob` were
two), so they now group. The triage of such an error is lost, as it is whenever a change of code moves the line it
is thrown from.

The frozen-rules test of ADR 0170 names this as its third exception, beside a backtick and `://`. A message made
only of ASCII, with no backtick, no `://` and no word with a separator and something else in it, comes out exactly
as it did before gh-684. The exception is written with a split on spaces and not with the rule, so it bounds the rule
instead of copying it, and a slash on its own stays in the corpus, where the rule has to leave it be.

## Alternatives

**A path read from its root only**, a word that starts with `/` with a second `/` or a `?` in it (the ticket's
minimal reading). It would keep `i/o` and `application/xml`. It would also leave `uploads/alice/orders.csv`,
`alice/orders.csv` and `api.example.com/users/alice` whole. With a word that has a separator in it, the doubt is
real, and `product.md:104` settles doubt on the side of omitting.

**Keeping the first segment** (`/users/?`), or the root (`/?`). The first segment is the one a tenant or a handle
sits in. The root says nothing that `?` does not.

**Keeping the segments that do not look like values**, as the route heuristic does for a request's URL. It keeps
`alice`, which is the case the rule is for.

**Treating a host with a path and no scheme as a URL**, keeping the host. It would keep `ana.perez` in
`ana.perez/orders`, and the only thing that told a host apart in ADR 0170, the scheme, is missing.

**Stopping a path at a comma or a closing parenthesis**, so that `(see /x/y), then` would read better. Those
characters are legal in a path, and a rule that stopped at them would leave what follows: `/srv/exports/orders,alice`
would let `alice` out.

## Consequences

- One more value pattern, with five cases of its own in `test/support/sanitiser-cases.ts`: a path with its query, a
  POSIX file path, a Windows file path, a relative path, and a host with a path and no scheme. The gh-651 guard holds:
  every rule decides a case no other rule decides. Nineteen mutations of the rule were each run against the suite,
  and seventeen turn it red: deleting the rule, dropping each of its three lookarounds, loosening or tightening the
  URL exclusion, taking a `\` on its own, forgetting either separator, starting at the separator, reading from a root
  only, stopping at a `?` or at a comma and a parenthesis, keeping the root or the first segment, needing two
  separators, and reading it before the quotes. Two of those survived the first run and are covered now. The two that
  stay green move it before the URL rule and after the digit rule, and both are equivalent.
- The reference app's `provider call /authorize failed after 3 attempt(s)` now travels as
  `provider call ? failed after ? attempt(s)`.
- A path with a space in it, outside quotes, still leaves the words after the space.
- A URL whose path follows its host with a `\` (`https://api.example.com\users\alice`) is ADR 0170's rule's and still
  leaves whole, since the host reads up to a `/`. Found while writing this, and it has its own ticket, gh-713.
- What already left with a path in it stays in the cloud until the cloud forgets it. Nothing here removes it.
