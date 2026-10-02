/**
 * One tool per capability of `product.md:188`, named after the capability and not after the HTTP route: a
 * coding agent looks for "verify the recovery", not for `GET /findings/{id}/verification`.
 *
 * Invariant 13 is the rule this list answers to — what the interface can do, a program can do — so a
 * capability missing here is a bug and not an omission (gh-281).
 */

/**
 * One argument, in the part of JSON Schema a client can act on before it calls: the type, the closed set of
 * values when there is one, the format of an instant and the bounds of a count (DT-9). The same in every
 * revision this server speaks.
 */
export interface Property {
  type: "string" | "number" | "integer";
  description: string;
  /**
   * The values the cloud accepts, when it accepts a closed set. Written here because this package cannot
   * read the cloud (invariant 10); the end-to-end walk compares each one with the cloud's enumerator, in both
   * directions.
   */
  enum?: readonly string[];
  /** An RFC 3339 instant. */
  format?: "date-time";
  minimum?: number;
  maximum?: number;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Property>;
    required?: string[];
  };
  /** How to reach it. `path` may carry `{slug}`, `{id}` and `{hypothesis}`. */
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Which input fields go in the query string rather than the body. */
  query?: string[];
  /**
   * Query parameters the tool always sends, whatever the arguments say: they are not arguments, so a caller
   * neither sees nor changes them. How a read asks for the shape that suits a coding agent's context when the
   * API's default is another (DT-15).
   */
  fixedQuery?: Record<string, string>;
  /** True when this changes something: the caller sends an idempotency key and, sometimes, a version. */
  operates?: boolean;
  /**
   * For an operation: whether it can take back or overwrite what somebody decided —close, accept, reopen,
   * move a triage state, silence or lift a silence— rather than only add a record beside the others. Every
   * operation says which, and it is published as `destructiveHint` (DT-9): a hint for the client, while the
   * cloud still decides by the credential's level.
   */
  destructive?: boolean;
  /** True when RES-01 names this as depending on the report a decision was read from (ADR 0074). */
  versioned?: boolean;
}

const project = { type: "string", description: "The project's slug." } as const;
const finding = { type: "string", description: "The finding's numeric id." } as const;
const capture = { type: "string", description: "The capture's id." } as const;
const error = {
  type: "string",
  description: "The error's identifier, as `list_errors` gives it.",
} as const;
/**
 * The orders `list_errors` takes, which its description is built from. The cloud defines them and refuses any
 * other with the list of the ones it has, because a package here cannot read the cloud's (invariant 10); the
 * end-to-end walk checks that this names every one of them.
 */
export const errorOrders = ["last-seen", "first-seen", "occurrences"] as const;

/** The two directions every ordered list takes. */
const directions = ["desc", "asc"] as const;

const why = {
  type: "string",
  description:
    "Why you are doing this. Required when authenticating with the shared administration " +
    "password, which cannot say who you are.",
} as const;

/**
 * The key of an operation, declared by every tool that operates (gh-747). The server sends the caller's
 * key when it is given and generates one when it is not, and the cloud keeps a retry of an operation from
 * being a second one (RES-01).
 */
const idempotencyKey = {
  type: "string",
  description:
    "Idempotency key of this operation. Pass the same key when you retry the operation after a failure " +
    "or a dropped connection: the cloud answers the retry with the result of the first call, so the retry " +
    "is not a second operation. A new operation passes a different key, or none — without one the server " +
    "generates it. Two operations that only look alike, the same note written twice on purpose, must not " +
    "share a key.",
} as const;

/**
 * What each operation's description says about the key, where the agent reads it: when a key says «this
 * call is the retry of the operation I just attempted», and when it must not (gh-747).
 */
const idempotentRetry =
  " A retry of this operation after a failure or a dropped connection passes the same `idempotencyKey` " +
  "again, so it is not a second operation; a new operation passes a different one, or none.";

/**
 * The version of the report a decision on this finding was read from. Required by every tool that is
 * `versioned` (gh-748): the cloud keeps the header optional for its HTTP callers, where forcing it would
 * break the published contract (ADR 0074), but the caller of this server is an agent that reads
 * `tools/list`, and an argument it does not see is not sent — the operation would then be applied having
 * checked nothing, which is deciding blind.
 */
const version = {
  type: "string",
  description:
    "The version of the report you read before deciding, the `version` field the report of this finding " +
    "carries, the one `read_report` gives. The operation is checked against it: if the report moved since " +
    "you read it, the cloud refuses it without changing anything and says the version it has now. Only the " +
    "report's `version` matches — the `version` of any other read never does — and an assessment or an " +
    "annotation of your own moves it, so read the report again before the next decision.",
} as const;

export const tools: Tool[] = [
  {
    name: "read_credential",
    description:
      "What the credential this server was given can do, asked before attempting anything: the project it belongs " +
      "to, with its slug and name; its own name, id and level —read, operate or admin—; when it expires, null when " +
      "it does not; the environments it reaches; and every route of a project with the level it needs and whether " +
      "this credential opens it. Call it first when you do not know the project's slug: a project's credential " +
      "belongs to one project, this names it, and the list of projects does not open with it. Given the shared " +
      "administration password, it answers level admin and no project, and every route closed: through this " +
      "server the password opens `list_projects` and this, and a project's reads and operations need an access " +
      "credential of that project. An operation refused for its level answers 403 with the level the credential " +
      "has and the level the operation needs; a token that is not a usable credential —invented, expired or " +
      "revoked— answers 401.",
    inputSchema: { type: "object", properties: {} },
    method: "GET",
    path: "/api/credential",
  },
  {
    name: "list_projects",
    description:
      "The list of projects, in the order the front page reads them: the ones with open findings first, then by " +
      "name. For each, its slug, its name, how many findings are open, when its last batch arrived —null when " +
      "nothing ever arrived, which is not the same as quiet— and the word of the front page's column: `N open`, " +
      "`none` or `not compared`, which is nothing arrived in the last hour, so the detectors had nothing to " +
      "compare. The front page is about every project, so it opens with the shared administration password and " +
      "with no other credential; a project's own key does not list the others, and is refused with a 403. The " +
      "password opens the list and `read_credential`, and no tool about a project: those answer it a 403 that " +
      'says they need an access credential of that project, `needs: "access credential"`. With a project\'s ' +
      "credential, `read_credential` names that project.",
    inputSchema: { type: "object", properties: {} },
    method: "GET",
    path: "/api/projects",
  },
  {
    name: "project_status",
    description:
      "What a project looks like right now: traffic, endpoints, dependencies, runtime health, coverage " +
      "and the data budget with its consumption. The endpoints come in the order you ask for, and the " +
      "answer says which order it applied under `endpointsSort`.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        sort: {
          type: "string",
          enum: ["environment", "endpoint", "requests", "errors", "p50", "p95", "p99", "max"],
          description:
            "What to order the endpoints by. `requests` is the default, and `errors` is the share of requests " +
            "that returned 5xx. By the measurement, not by the text it is printed as, and a route with no " +
            "requests is last on every measurement.",
        },
        order: {
          type: "string",
          enum: directions,
          description:
            "Which way. By default the worst first for a measurement and alphabetical for a name, which is " +
            "what the page does on the first click.",
        },
      },
      required: ["project"],
    },
    method: "GET",
    path: "/api/p/{slug}/status",
    query: ["sort", "order"],
  },
  {
    name: "list_findings",
    description: "The findings of a project, open and recently closed, grouped into the incidents they form.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
    method: "GET",
    path: "/api/p/{slug}/findings",
  },
  {
    name: "read_finding",
    description: "One finding: what was measured, what it is attributed to, what has been said about it.",
    inputSchema: { type: "object", properties: { project, finding }, required: ["project", "finding"] },
    method: "GET",
    path: "/api/p/{slug}/findings/{id}",
  },
  {
    name: "read_report",
    description:
      "The report of a finding: facts, hypotheses with their state and evidence, the overall confidence " +
      "level with the fields its reasons come from, recommendations tied to the hypothesis they rest on, and " +
      "everything it cannot say. Start here. It carries a `version`, and that is the one `close_finding`, " +
      "`accept_reference` and `assess_hypothesis` take: they are decisions on this report, and the cloud " +
      "refuses them without changing anything if the report moved since.",
    inputSchema: { type: "object", properties: { project, finding }, required: ["project", "finding"] },
    method: "GET",
    path: "/api/p/{slug}/findings/{id}/report",
  },
  {
    name: "compare_windows",
    description:
      "What changed between the degraded window and its reference: the differences ordered by how much " +
      "they explain, with the attribution and its limits.",
    inputSchema: { type: "object", properties: { project, finding }, required: ["project", "finding"] },
    method: "GET",
    path: "/api/p/{slug}/findings/{id}/diff",
  },
  {
    name: "verify_recovery",
    description:
      "Did what I changed work? Observed recovery, persistent degradation or inconclusive, by scope, and " +
      "never a claim that the intervention caused it.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        since: {
          type: "string",
          format: "date-time",
          description: "RFC 3339 instant of the intervention. Required.",
        },
      },
      required: ["project", "finding", "since"],
    },
    method: "GET",
    path: "/api/p/{slug}/findings/{id}/verification",
    query: ["since"],
  },
  {
    name: "read_history",
    description:
      "What a project looked like further back than the fine-grained data goes, hour by hour. " +
      "`baselineFrom` and `baselineTo`, both or neither, are the other window the history page compares " +
      "against: with them the answer adds `baseline`, the window as asked for with whether the series covers " +
      "it, and `comparison`, one row per endpoint and metric with before, after, the change and whether it " +
      "got worse — the same table the page shows. One of the two alone is refused with the reason the page " +
      "gives for the same selection, and a side with nothing in the series comes back as `comparison: []` " +
      "with `limits` naming the side.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        from: { type: "string", format: "date-time", description: "RFC 3339 instant." },
        to: { type: "string", format: "date-time", description: "RFC 3339 instant." },
        baselineFrom: {
          type: "string",
          format: "date-time",
          description:
            "RFC 3339 instant: the start of the other window, the one to compare against. Goes with " +
            "`baselineTo`, both or neither.",
        },
        baselineTo: {
          type: "string",
          format: "date-time",
          description:
            "RFC 3339 instant: the end of the other window, the one to compare against. Goes with " +
            "`baselineFrom`, both or neither.",
        },
      },
      required: ["project", "from", "to"],
    },
    method: "GET",
    path: "/api/p/{slug}/history",
    query: ["from", "to", "baselineFrom", "baselineTo"],
  },
  {
    name: "list_errors",
    description:
      "Every error this project has observed, from the first one: its identity, how many times, when it " +
      "was first and last seen, and in which environments, versions and routes. `kind` says how the " +
      "instrumentation came to see it — an instrumented operation failed, the framework turned it into a " +
      "5xx, the application reported it itself, or the process threw it outside any request. No traffic " +
      "minimum and no detector involved — an error is an observed fact, a finding is a detected " +
      "difference, and the absence of a finding about an error says nothing either way. They come in the " +
      "order you ask for, the one the page's headers give, and the answer says which order it applied " +
      "under `sort`. `reporting` says which kinds of error cannot reach the list at all from the instances " +
      "reporting now, by the protocol each one speaks: an empty list from those is not an absence of errors.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return. Fifty by default." },
        sort: {
          type: "string",
          enum: errorOrders,
          description:
            `What to order them by: ${errorOrders.map((o) => `\`${o}\``).join(", ")}. The first is when ` +
            "each was last seen, and the default; then when it was first seen, which puts first what arrived " +
            "most recently; and how many times it was seen. Applied before the limit, so the first fifty by " +
            "first seen are the fifty newest errors and not the fifty last seen in another order. Errors that " +
            "tie stay in the default order.",
        },
        order: {
          type: "string",
          enum: directions,
          description: "Which way. `desc` is the default: the newest or the most first.",
        },
        state: {
          type: "string",
          enum: ["waiting", "open", "resolved", "ignored", "reappeared", "all"],
          description:
            "Which triage states to list. `waiting` is the default: open and reappeared, the ones waiting for " +
            "somebody; `all` is every state. Whatever you ask for, the answer says which filter it applied and " +
            "how many errors it is not showing.",
        },
      },
      required: ["project"],
    },
    method: "GET",
    path: "/api/p/{slug}/errors",
    query: ["limit", "state", "sort", "order"],
  },
  {
    name: "read_error",
    description:
      "One error and where it was seen: every environment, deployed version and route it happened on, each " +
      "with its own count and its own first and last sighting. When the application reported the error " +
      "itself it also carries, under `fromService`, the structural context it attached — bounded and " +
      "sanitised by the sender, and the one it sent with the first occurrence of that signature. It also " +
      "carries its triage: the state it is in, who left it there and why, and the whole history, including " +
      "any reappearance with the version it was resolved in and the one it came back in.",
    inputSchema: {
      type: "object",
      properties: { project, error },
      required: ["project", "error"],
    },
    method: "GET",
    path: "/api/p/{slug}/errors/{id}",
  },
  {
    name: "resolve_error",
    description:
      "File an error as dealt with, attributed. That is all it does: it accepts no reference, silences no " +
      "detector and proves nothing about the code, and the occurrences go on being counted. If this error " +
      "happens again in a deployed version the project first sees after you resolve it, it comes back on " +
      "its own as a reappearance of the same error, naming both versions — not as a new error. Resolving " +
      "one that is already resolved is refused, because it would overwrite who resolved it." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: { project, error, why, idempotencyKey },
      required: ["project", "error"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/resolve",
    operates: true,
    destructive: true,
  },
  {
    name: "ignore_error",
    description:
      "Take an error out of the default list until a moment you choose, after which it comes back on its " +
      "own. It silences no detector and no alert, and every occurrence is still counted: no news must never " +
      "be able to mean nothing is happening. An error that is already resolved cannot be ignored." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        error,
        until: {
          type: "string",
          format: "date-time",
          description: "RFC 3339 instant, at most thirty days away. Required.",
        },
        why,
        idempotencyKey,
      },
      required: ["project", "error", "until"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/ignore",
    operates: true,
    destructive: true,
  },
  {
    name: "unignore_error",
    description: "Bring an ignored error back into the default list before its time is up." + idempotentRetry,
    inputSchema: {
      type: "object",
      properties: { project, error, why, idempotencyKey },
      required: ["project", "error"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/unignore",
    operates: true,
    destructive: true,
  },
  {
    name: "annotate_error",
    description:
      "Say what you know about an error and Downtrace could not measure: 'only with the legacy checkout', " +
      "'the provider confirms an incident'. It is kept beside the evidence and never on top of it — it " +
      "moves no state and changes no measurement." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        error,
        note: { type: "string", description: "What you know. Required." },
        idempotencyKey,
      },
      required: ["project", "error", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/annotations",
    operates: true,
    destructive: false,
  },
  {
    name: "list_captures",
    description: "The captures of a project, with the budget and what a capture cannot do.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
    method: "GET",
    path: "/api/p/{slug}/captures",
  },
  {
    name: "read_capture",
    description:
      "One capture and whatever evidence has arrived, with both of its coverages, how the requests it kept spent " +
      "their time, and which fraction of its footprint's requests those were. The requests themselves are not in " +
      "it: a delivery can hold thousands, each with its operations. Each instance's evidence says how many it " +
      "holds (`requests.count`), how large they are (`requests.bytes`) and where their first page is " +
      "(`requests.links.first`); read them a page at a time, or one by its index, with `read_captured_requests`. " +
      "The coverages are what arrived; a delivery that did not fit whole in the evidence budget was stored with " +
      "its oldest requests left out, and `coverage.notStored` says how many, beyond what one delivery may hold " +
      "and beyond what the capture had left — requests that were served and are not in the evidence. " +
      "A capture is finished when `pending` is false, and not before: evidence can be there while it is still " +
      "`collecting`, waiting a short while for the other instances that served its footprint to deliver theirs, " +
      "and `retryAfterSeconds` says when to read it again.",
    inputSchema: {
      type: "object",
      properties: { project, capture },
      required: ["project", "capture"],
    },
    method: "GET",
    path: "/api/p/{slug}/captures/{id}",
    fixedQuery: { requests: "summary" },
  },
  {
    name: "read_captured_requests",
    description:
      "The requests one instance kept for a capture, a page at a time and in the order they arrived. Each comes " +
      "with its `index`, its place in that instance's delivery, which is how a request is cited and asked for " +
      "again: `offset` at the index and `limit` at 1 is that one request, now or later, because a delivery is " +
      "never rewritten. The answer says the `total` and, while there are more, the `next` page. What each request " +
      "did — its route, its status, its duration and its operations — is under `fromService`.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        capture,
        instance: {
          type: "string",
          description:
            "The instance whose requests to read, as `read_capture` names it under `evidence[].instance`. It can " +
            "be left out when one instance delivered; with several, the answer names them.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The index of the first request to return, up to the delivery's total. 0 by default.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "How many to return. Twenty by default." },
      },
      required: ["project", "capture"],
    },
    method: "GET",
    path: "/api/p/{slug}/captures/{id}/requests",
    query: ["instance", "offset", "limit"],
  },
  {
    name: "list_regressions",
    description: "What this project says Downtrace missed.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
    method: "GET",
    path: "/api/p/{slug}/regressions",
  },
  {
    name: "request_capture",
    description:
      "Ask for detail on a route or a dependency for a while. Accepting is not observing: the answer says " +
      "it is queued, and nothing recovers detail that was not kept." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        environment: { type: "string", description: "The environment to watch." },
        method: { type: "string", description: "HTTP method of the route, when watching a route." },
        route: { type: "string", description: "Route template, when watching a route." },
        kind: { type: "string", description: "Dependency kind, when watching a dependency." },
        target: { type: "string", description: "Dependency target, when watching a dependency." },
        windowSeconds: { type: "integer", description: "How long to watch for, in whole seconds." },
        why,
        idempotencyKey,
      },
      required: ["project", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/captures",
    operates: true,
    destructive: false,
  },
  {
    name: "close_finding",
    description:
      "Close a finding by hand, with one of the three reasons the product allows. This is not observed " +
      "recovery and is never presented as one. A finding that is already closed, with the same reason or " +
      "another, is not closed again, because that would overwrite who closed it and why: the cloud answers " +
      "409, changes nothing, and says how it stands closed — `closedReason`, `closedBy`, `closedNote` and " +
      "`closedAt`, with no `closedBy` when nobody closed it by hand. If that close is your own and its answer " +
      "never reached you, the 409 is it." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        reason: {
          type: "string",
          enum: ["expected", "noise", "resolved-without-telemetry"],
          description:
            "Which of the three: it was expected, it was noise, or you resolved it and there is no telemetry " +
            "to confirm it.",
        },
        why,
        version,
        idempotencyKey,
      },
      required: ["project", "finding", "reason", "why", "version"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/close",
    operates: true,
    destructive: true,
    versioned: true,
  },
  {
    name: "accept_reference",
    description:
      "Accept the current behaviour as the new normal for this finding. A finding that is already closed is " +
      "not accepted, also when it is already accepted, because a second acceptance would overwrite who " +
      "accepted it, why and since when the same difference stays quiet: the cloud answers 409, changes " +
      "nothing, and says how it stands closed — `closedReason` and `closedAt` — with, when an acceptance closed " +
      "it, that acceptance in `accepted`: `by`, `why`, `at` and whether `declared`. If that acceptance is your " +
      "own and its answer never reached you, the 409 is it; a correction to the reason is an annotation." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: { project, finding, why, version, idempotencyKey },
      required: ["project", "finding", "why", "version"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/accept-reference",
    operates: true,
    destructive: true,
    versioned: true,
  },
  {
    name: "assess_hypothesis",
    description:
      "Record your own reading of a hypothesis. It sits beside Downtrace's and never overwrites it." + idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        hypothesis: { type: "string", description: "The hypothesis' stable id." },
        state: {
          type: "string",
          enum: ["supported", "weakened", "discarded", "not-assessed"],
          description: "Your reading, in the same four states Downtrace's own evaluation uses.",
        },
        why,
        version,
        idempotencyKey,
      },
      required: ["project", "finding", "hypothesis", "state", "why", "version"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/hypotheses/{hypothesis}/assessment",
    operates: true,
    destructive: false,
    versioned: true,
  },
  {
    name: "give_feedback",
    description:
      "Rate a finding on the two axes: was the diagnosis right, and was the alert worth having. It changes " +
      "nothing about the finding. It is recorded as a rating given by a coding agent, which is what calls " +
      "this server, and counts apart from the person's: an agent that confirms the diagnosis it has just " +
      "used is agreeing with itself, so it counts as a signal, not as accuracy." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        accuracy: {
          type: "string",
          enum: ["correct", "partial", "incorrect", "not-assessable"],
          description: "Was the diagnosis right.",
        },
        usefulness: {
          type: "string",
          enum: ["useful", "unnecessary"],
          description: "Was the alert worth having.",
        },
        note: { type: "string", description: "The justification of the rating, when you have one." },
        idempotencyKey,
      },
      required: ["project", "finding"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/feedback",
    operates: true,
    destructive: false,
  },
  {
    name: "annotate_finding",
    description:
      "Say what Downtrace could not measure: 'reverted at 15:02', 'the provider confirms an incident'. " +
      "Also acknowledge, hand back, or reopen a finding that was closed by hand." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        kind: {
          type: "string",
          enum: ["note", "acknowledge", "unacknowledge", "reopen"],
          description:
            "What it is: a note, the default; acknowledging the finding, or taking that back; or reopening a " +
            "finding that was closed by hand.",
        },
        note: { type: "string", description: "What you know. Required." },
        idempotencyKey,
      },
      required: ["project", "finding", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/annotations",
    operates: true,
    destructive: true,
  },
  {
    name: "record_regression",
    description:
      "Record something Downtrace did not detect. Nothing reads these yet; they are the record of what the " +
      "detector missed." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: { project, note: { type: "string", description: "What happened. Required." }, idempotencyKey },
      required: ["project", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/regressions",
    operates: true,
    destructive: false,
  },
  {
    name: "silence_alerts",
    description:
      "Stop being told about something, with a scope and an end. It silences the alert, never the detector: " +
      "the finding still opens and still counts." +
      idempotentRetry,
    inputSchema: {
      type: "object",
      properties: {
        project,
        scope: {
          type: "string",
          enum: ["project", "footprint"],
          description: "`project` silences every alert of the project; `footprint`, those of one finding's footprint.",
        },
        finding: {
          type: "string",
          description:
            "The finding's numeric id, when `scope` is `footprint`: the silence takes the finding's whole " +
            "footprint from it, so nothing is typed by hand and a finding without a route is silenced too. " +
            "Refused with `project`. The detector keeps running: the finding still opens and still counts.",
        },
        until: { type: "string", format: "date-time", description: "RFC 3339 instant, at most thirty days away." },
        why,
        idempotencyKey,
      },
      required: ["project", "scope", "until", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/silences",
    operates: true,
    destructive: true,
  },
  {
    name: "lift_silence",
    description: "End a silence before its time." + idempotentRetry,
    inputSchema: {
      type: "object",
      properties: { project, silence: { type: "string", description: "The silence's id." }, idempotencyKey },
      required: ["project", "silence"],
    },
    method: "DELETE",
    path: "/api/p/{slug}/silences/{id}",
    operates: true,
    destructive: true,
  },
];

export function toolNamed(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
