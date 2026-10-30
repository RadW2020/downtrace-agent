# 0238 — A long quoted name that reads as words is a name, and not a token

Estado: aceptado · Fecha: 2026-10-30 · Matiza el ADR 0090 · Alcance: público

## Context

ADR 0090 sanitises what is between the quotes of a SQL identifier with the value patterns of a message: emails,
UUIDs, words with a digit, and long runs — sixteen letters, digits, `_` or `-` or more. The long run is there for
tokens: a session id or an API key with no digit is still a run of sixteen.

An ORM quotes every name it writes. Kysely, Sequelize, TypeORM and Prisma all do, so Kysely's
`update "users" set "dateOfLastAccess" = $1` travelled as `update "users" set ? = ?`: unreadable, and with the hash of
every other update of one long column of `users`, because the hash is a digest of the label. The same name unquoted
was kept all along. The stranger campaign met it running public repositories cold: Tony133's Fastify boilerplate on
Kysely, and Outline on Sequelize, whose labels read `?` where `"collection_group_memberships"` was.

## Decision

**In a quoted name, a long run stays when it reads as words.** It reads as words when it has no digit and every part
of it between `_` and `-` is either one word shorter than sixteen letters, or breaks where its case changes into words
of three letters or more on average. `dateOfLastAccess`, `lastHTTPResponseCode` and `maintainer_approval_required`
stay; `tenant_8f3a9c2e1b7d4f60`, `kQzXwPfLmNbVtRsY` (nine words of fewer than two letters: a token's case is drawn
letter by letter) and `kqzxwpflmnbvtrsy` go.

The last one is the reason for the sixteen-letter part: nothing tells sixteen letters in one case from a token, so
they keep going as ADR 0090 had them, and `"userpreferenceshistory"`, `WSAEPROTONOSUPPORT` with them. Measured on the
twenty-one thousand names of sixteen letters or more and no digit in the type declarations this repository installs,
the rule takes one in fifty, every one of them a run its case does not break.

A message and the key of a context are not names, and read every long run as a token, as before.

## Alternatives

**Keep every long run that has no digit.** It spares `kqzxwpflmnbvtrsy` too, and with it a lower-case token and a
customer's name glued into a tenant's table (`"mariagarciaperez"`). Discarded: the case of a name is the only thing
that tells it from a token here, and a run with none of it has given nothing to go on.

**Spare quoted names only for the ORMs that write them.** The normaliser does not know who wrote a query, and a name
an ORM writes is no different from one a person quotes.

## Consequences

- A query with a long name that reads as words has a label and a hash of its own: after the upgrade it is a new query
  and the old one stops being seen, once. Every other query keeps its hash.
- **ADR 0090's limit grows by one shape, said:** a name built from data out of words — `"alice_smith_marketing"`,
  `"MariaGarciaPerez"` — has the shape of a name and travels as one, as `"acme_corp"` already did.
  `DOWNTRACE_QUERY_TEXT=off` keeps it home.
- In MySQL a double-quoted run is a string, and stays a value whatever it reads as.
