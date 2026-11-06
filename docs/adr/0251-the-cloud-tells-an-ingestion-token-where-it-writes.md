# 0251 — The cloud tells an ingestion token where it writes, and nothing more

Estado: aceptado · Fecha: 2026-11-06 · Amplía el protocolo 0.13.0 · Alcance: público

## Context (DT-134)

The first question after installing the instrumentation is whether it works, and nothing answered it. The answer to an
accepted batch said how many intervals the cloud took and which captures it was waiting for, never where the batch
landed. An ingestion token could be sent to two places, a batch and a capture's evidence, and both carry data. A pilot
integration checked its token by posting `{}` to `/v0/aggregates` and reading the 400 as «the token passed»: a 401
would have meant a bad token. Each of those checks was also a batch the cloud refused, which it records as coverage the
project lost.

On 2026-11-06 the human asked for three things: a line when the first batch is accepted, naming the project and the
environment; a `downtrace verify` that checks a token without sending data; and, under `DOWNTRACE_DEBUG`, the drivers
the start found. The first two need the cloud to say where a token writes. Invariant 11 bounds what it may say:
ingestion tokens only ingest, and never grant query or operation access.

## Decision

**Protocol 0.14.0 adds `Destination`, where an ingestion token writes: the project's slug and the environment, and
nothing else.** It is defined once, in `ingest-response.schema.json`, closed to any other field, and generated for both
sides like every other type of the protocol (invariant 9).

1. **The answer to an accepted batch carries it, as `destination`**: the token's project, and the environment the batch
   landed in. That is the token's environment, or, for a token minted before tokens named one, the environment the
   batch declared. Optional, like every field of the answer: an instrumentation that ignores it behaves as before.
2. **`GET /v0/destination`, with the token as a bearer, answers 200 with a `Destination`, and ingests nothing**: no
   row, no coverage restored or lost, no capture asked. For a token that names no environment it names only the
   project, because there is no batch to declare one. The path is `x-destination-path` on `Destination`, generated as
   `DESTINATION_PATH` and `DestinationPath`.
3. **The check is the batch's door.** A token the cloud does not know is the same 401. A failure spends the same
   budget of failed authentications per address, and a token's checks spend the same per-token rate as its batches,
   before the store is asked. Checking is no cheaper a way to guess a token than ingesting already was.
4. **What it names is what the token already holds.** A token belongs to one project and names one environment, and
   saying so is not a read of the project. The project's name, its other environments, whether anything arrived and
   anything else the cloud knows stay out of both answers: the token still reads nothing.

## Alternatives

- **Post `{}` and read the status**, which is what the pilot did. It reads a refusal as an answer, and every check is
  recorded as a refused batch.
- **A dry run of `POST /v0/aggregates`**, a header or a parameter that validates and stores nothing. One door with two
  meanings, a body shaped like a batch for a question that has none, and every guard that reads a `POST` as a mutation
  would have to learn the exception.
- **Opening `GET /api/credential` to ingestion tokens.** That endpoint belongs to the access credentials and lists every
  route of a project. Opening the API to an ingestion token, even for one read, is the crossing invariant 11 forbids.
- **The project's name beside its slug.** The slug is how a token, the CLI and the URLs name a project; the name is a
  label the operator chose, and nothing that holds only a token needs it.
- **`POST`, or a path such as `/v0/token`.** A check mutates nothing, and a `GET` says so to every proxy and reader. A
  path named after the token reads as the place where tokens are handed out.

## Consequences

- A cloud older than this answers a batch without `destination`, and the check with 404. A reader takes the absence as
  «not said», never as «nowhere»: the instrumentation's line says only that the cloud accepted the batch (DT-155), and
  `downtrace verify` says the cloud cannot check tokens yet (DT-156).
- The ingestion surface has its first `GET`. The cloud's tests that walked every `GET` outside `/api` as a page ask the
  router for its pages instead, and the router leaves out `/v0/`, which only an ingest token opens.
- Whoever holds a token learns the slug of its project. A token is public, like a Sentry DSN (DT-132), and so is that
  slug: it opens nothing without an access credential.
