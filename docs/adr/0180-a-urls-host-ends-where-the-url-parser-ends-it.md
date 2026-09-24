# 0180 — A URL's host ends where the URL parser ends it

Estado: aceptado · Fecha: 2026-09-24 · Alcance: público

## Context (gh-713)

ADR 0170 gave a URL its rule in `src/sanitize.ts`: the scheme stays, and the host and its port when the authority is
nothing else, and the path, the query and the fragment go. The rule read the host up to a `/`, a `?`, a `#` or a
space. ADR 0175 gave a word with a `/` or a `\` in it its own rule, and left alone a word that opens with `scheme://`,
since that is a URL and ADR 0170's. So a `\` after a host was neither rule's. Measured on `4cd3c49` with
`sanitizeMessage`, `request to https://api.example.com\users\alice failed` came out whole, and Node's own parser reads
that `\` as a `/`: `new URL("https://api.example.com\\users\\alice").pathname` is `/users/alice`.

The ticket named that one shape. The URL standard lets a special scheme (`http`, `https`, `ws`, `wss`, `ftp`, `file`)
read a `/` in more places than one, so each place where the parser may end a host was checked, with each code point of
the BMP put there in turn and Node 26.8.1's `URL` as the judge. Only `/`, `\`, `?`, `#` and `@` ever end a host, and
three shapes left:

- a `\` after the host, in all six schemes;
- a `\` straight after `://` (`https://\api.example.com\users\alice`), in all six;
- no slash at all after a special scheme, which the parser accepts: `https:api.example.com?name=alice` and
  `https:api.example.com#alice` left whole, and `https:payroll:hunter@db.internal` left `https:payroll:?`, the email
  rule taking the password and the host as it did before ADR 0170.

Everything else already went. A `\` after a port made the authority not plain, so the URL went whole. Any mix of `/`
and `\` after the scheme other than `//` (`https:\\host\x`, `https:/\host`) is a word with a separator in it, and the
path rule took it whole. Three slashes or more leave an empty host, and the URL rule took the rest.

## Decision

**1. A `\` ends a host as a `/` does, and the host stays.** The ticket gave two options: this one, or «a host with a
`\` in it is not a host, and the URL goes whole after its scheme». The parser settles it. In a special scheme a `\` is
a `/`, so `api.example.com` is the host and what follows is the path, and ADR 0170 keeps a host when the authority is
a host and a port.

```
request to https://api.example.com\users\alice failed          →  request to https://api.example.com\? failed
request to https://\api.example.com\users\alice failed         →  request to https://\? failed
request to https://api.example.com:8080\users\alice failed     →  request to https://api.example.com:?\? failed
```

The URL with a port used to go whole, as `https://?`, only because the rule did not know a `\`. It now keeps its host
and its port, as one with a `/` does, and the digit rule takes the port's digits as it takes any.

The rule stays blind to the scheme after `://`, as ADR 0170 wrote it. For a scheme that is not special the parser
refuses a `\` in a host, so nothing after one is a host either: `postgres://db.internal\orders` →
`postgres://db.internal\?`.

**2. A special scheme with no slashes after it opens an authority, as the parser reads one.**

```
request to https:api.example.com?name=alice failed   →  request to https:api.example.com? failed
could not connect to https:payroll@localhost         →  could not connect to https:?
```

A user in the authority takes the rest with it, as it does after `://`. Only the six special schemes, since only for
them does the parser read an authority without `//`. The scheme is recognised as the parser recognises one:

- A name that follows a letter, a digit, a `+`, a `-` or a `.` is the end of another name. `rows:id:desc` has the
  scheme `rows`, not `ws`, and it is left alone; so are `git+ws:`, `x-ws:` and `a.ws:`.
- Case does not matter, since the parser lowercases a scheme.
- A special scheme followed by any slash but `//` stays the path rule's, which takes the word whole.

`file` is among the six although what follows `file:` is a path to the parser, not a host. A word with no separator in
it stays wherever it is (`cannot read orders.csv`), so keeping it adds nothing, and its query and fragment go as any
URL's do: `open file:orders.csv?name=alice` → `open file:orders.csv?`.

**3. Identity: the change is accepted, said, and pinned, as in ADR 0170 and ADR 0175.** An error whose message carried
one of these shapes gets a new signature after the upgrade, once. The cloud lists it as a new error, newly observed,
and the old one stops being seen. The changeset and the README say so.

The frozen-rules test of ADR 0170 needs a fourth exception for decision 2, since a URL with no slashes has no `://`:
a message with a special scheme's name and its colon in it. Decision 1 needs none, because a `\` changes only a
message that already has a `://`. The exception is written as the six names and a colon, whatever precedes them, so it
bounds the rule instead of copying where the rule decides a scheme begins. It excludes none of the seeded corpus's
messages today.

## Alternatives

**A host with a `\` in it is not a host** (the ticket's second option): `https://api.example.com\users\alice` →
`https://?`. It is ADR 0083's side of doubt, but there is no doubt here: the parser reads a host and a path, and a
dependency target travels as that host already. Dropping it would hide which service failed for no gain against
invariant 5.

**Telling the schemes apart after `://`**, a `\` ending the host of a special scheme only. For any other scheme the
parser refuses the URL, and a rule that kept `db.internal\orders` whole as a host would keep `orders`.

**Leaving the URL with no slashes to the ticket for a query without a URL** (gh-720). That ticket's shape has no scheme
to say where a host is. This one does, and the parser reads it as a URL with a host, so it is this rule's.

**Treating every `:` with no slash after it as the start of an authority.** It would take `rows:id:desc` and any
`key:value:other` in a message whole, which the parser does not read as a URL.

**Normalising a `\` to a `/` before sanitising.** It would rewrite the text that travels, and a `\` in a Windows path
would become a `/` in the message the reader sees.

## Consequences

- Two cases of their own in `test/support/sanitiser-cases.ts`, a `\` after a host and a special scheme with no
  slashes, each decided by the URL rule alone; the gh-651 guard holds.
- A test that asks Node's parser instead of a list written by hand. Each code point below 128 is put in each place
  where the parser may end a host, in each special scheme, and wherever the parser still reads the host as written,
  nothing it reads outside that host may come out. Below 128 because the parser tells the parts of a URL apart by
  ASCII alone; the whole BMP was measured, and no other code point ends a host.
- Twenty-one mutations of the rule were each run against the agent's suite, and nineteen turn it red: the rule as it
  was, `\` taken out of where either branch ends a host or out of both, the authority with no slashes taken out or read
  by only one branch, a special scheme's colon let open an authority before `//`, no scheme boundary, a boundary of
  letters only or of `\b`, the scheme read in lower case only, each of the six schemes taken out of the list, and any
  colon opening an authority. Two survived the first run, the narrower boundaries, and are covered now. The two that stay
  green are equivalent:
  - the host's class without `\`, because the end of a host includes it and the lookarounds stop at the first one
    either way, as they already did for `/`, `?` and `#`;
  - the lookahead after a special scheme's colon forgetting `\`, because the path rule then takes the word whole
    anyway.
- A tab or a newline inside a URL is still the end of a word. The parser removes them wherever they are; the sanitiser
  reads them as it reads a space in a path (ADR 0175).
- A query that follows neither a path nor the host of a URL with its scheme (`api.example.com?name=alice`,
  `sms:ops?body=alice`) still leaves whole. It has its own ticket, gh-720.
- What already left with these shapes in it stays in the cloud until the cloud forgets it. Nothing here removes it.
