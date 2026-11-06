# @downtrace/protocol

> ⚠️ **Not production ready.** Downtrace is a closed free pilot: no plans, no billing and no SLA. The ingestion protocol is `v0` and can still change between minor versions. Install it where a dependency that is still moving is acceptable.

The ingestion contract between the Downtrace instrumentation and the Downtrace cloud: a JSON Schema (draft 2020-12) and the TypeScript types generated from it. Read it to write a sender in another language, or to validate what a sender sends.

```sh
npm install @downtrace/protocol
```

```ts
import { Ajv2020 } from "ajv/dist/2020.js";
import { AGGREGATES_SCHEMA_V0, type AggregatesBatch } from "@downtrace/protocol";

// The schema declares its constants as `x-` annotations; a strict validator has to be told they are keywords.
const ajv = new Ajv2020({ strict: true });
for (const k of ["x-latency-boundaries-ms", "x-calls-per-request-boundaries", "x-ingest-path", "x-since", "x-error"]) {
  ajv.addKeyword(k);
}
const isBatch = ajv.compile<AggregatesBatch>(AGGREGATES_SCHEMA_V0);

if (!isBatch(body)) throw new Error(ajv.errorsText(isBatch.errors));
```

`ajv` is not a dependency of this package: any draft 2020-12 validator will do.

## On the wire

`POST {DOWNTRACE_URL}/v0/aggregates`, with `Authorization: Bearer <token>` and an `AggregatesBatch` as JSON.

| Status | Meaning |
|---|---|
| 202 | Accepted. The body is an `IngestResponse`: where the batch landed (`destination`, since 0.14.0), and the captures the cloud is waiting for, if any. A sender that ignores the body still works, and simply never takes a capture. |
| 400 | Invalid, or a batch that carries nothing at all. The body says why. |
| 401 | Bad token. |
| 413 | Body too large. |
| 429 | Rate limit or daily budget. |

The evidence of a capture goes to `POST {DOWNTRACE_URL}/v0/captures/{id}/evidence` (`captureEvidencePath(id)`) as a `CaptureEvidence`, with the same token.

To check a token without sending data, `GET {DOWNTRACE_URL}/v0/destination` (`DESTINATION_PATH`) with the same header. It answers 200 with a `Destination`, the project and the environment the token writes to and nothing else, or 401 for a token the cloud does not know; it ingests nothing. A cloud older than 0.14.0 answers 404.

## What a batch carries

- **`agent`, `instance`, `deploy`** — who is sending: the instrumentation and its version, the process (`instance.id`, generated once per process) and the deployed version. `agent` also says what is being watched (`observers`), what is withheld on purpose (`withholding`), which sources of error are connected (`errorSources`) and what the instrumentation costs and has lost (`resources`).
- **`intervals`** — per interval (10 seconds) and per route: requests, 5xx errors, statuses by class and a **35-bucket fixed latency histogram** (0.5 ms → 60 s). Fixed buckets add up across instances, so the cloud computes percentiles for a whole fleet. Per dependency the route touched — a database, Redis, an outgoing HTTP host —: calls per request in 8 fixed buckets (0, 1, 2, 3–5, 6–10, 11–20, 21–50, 51+), total and slowest time, errors and pool wait. And the runtime's health: event loop delay, garbage collection, heap, resident set, peak in-flight requests.
- **`profile`** — once a minute, what each route normally runs: its queries, outgoing calls, Redis commands and errors, one operation each.
- **`exceptions`** — errors thrown outside any request.
- **`triggers`**, **`captures`** — local signals asking for a capture, and progress on the captures the cloud asked for.
- **`ending`** — this is the last batch of the process, and why: `signal`, `exit` or `idle`.

`intervals` may be empty whenever the batch carries anything else.

Two rules hold everywhere:

- **Absent is an answer of its own.** For what a sender says about itself — `observers`, `withholding`, `resources`, `errorSources`, `ending`, a captured operation's `kind` — absent means *did not say*, which is never zero, none or «nothing happened»: an older sender omits what it had no word for. Where absent means something else, the field's description says so.
- **The hash is the identity, the text is a label.** An operation is a `hash` plus an optional normalised `text`, and no value ever travels: no query literal, path, key or argument. A sender that sends no text keeps the whole analysis and loses only the label.

What each field means is in its `description` in the schema, which the generated types carry as doc comments.

## Versions

- **The package version is the protocol version.** `@downtrace/protocol@0.N.x` speaks protocol `0.N`, and CI refuses a release where the two disagree. A patch changes the package, never the contract.
- **Fields are only added, and always optional.** Each addition is a minor, and `protocol` is an enum of every published minor, so the cloud keeps accepting older senders. Removing or renaming a field, or moving a bucket bound, would be a new major on a new path.
- **The schema carries its own constants** as annotations: the bucket bounds (`x-latency-boundaries-ms`, `x-calls-per-request-boundaries`), the paths (`x-ingest-path`, `x-evidence-path`, `x-destination-path`), the first minor that carries each kind of operation and exception (`x-since`) and which kinds are errors (`x-error`).

What each minor added is in the [CHANGELOG](https://github.com/RadW2020/downtrace-agent/blob/main/packages/protocol/CHANGELOG.md).

## Contents

| Path | What |
|---|---|
| `schema/v0/aggregates.schema.json` | What a sender sends, `AggregatesBatch`. Everything else derives from it. |
| `schema/v0/ingest-response.schema.json` | What the cloud answers, `IngestResponse`, and where a token writes, `Destination`. |
| `schema/v0/capture-evidence.schema.json` | What a sender returns for a capture, `CaptureEvidence`. |
| `schema/v0/fixtures/{valid,invalid}/` | Examples every implementation must accept and reject. |

Exports: the three schemas (`AGGREGATES_SCHEMA_V0`, `INGEST_RESPONSE_SCHEMA_V0`, `CAPTURE_EVIDENCE_SCHEMA_V0`), the versions (`PROTOCOL_VERSION`, `ACCEPTED_PROTOCOL_VERSIONS_V0`), the paths (`AGGREGATES_PATH`, `CAPTURE_EVIDENCE_PATH`, `captureEvidencePath()`, `DESTINATION_PATH`), the buckets (`LATENCY_BOUNDARIES_V0`, `latencyBucket()`, `CALLS_PER_REQUEST_BOUNDARIES_V0`, `callsPerRequestBucket()`, …) and the type of every object in the schemas.

## Source

Developed in a monorepo and mirrored read-only to [RadW2020/downtrace-agent](https://github.com/RadW2020/downtrace-agent). MIT.
