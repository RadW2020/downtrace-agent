/**
 * One tool per capability of `product.md:188`, named after the capability and not after the HTTP route: a
 * coding agent looks for "verify the recovery", not for `GET /findings/{id}/verification`.
 *
 * Invariant 13 is the rule this list answers to — what the interface can do, a program can do — so a
 * capability missing here is a bug and not an omission (gh-281).
 */

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  /** How to reach it. `path` may carry `{slug}`, `{id}` and `{hypothesis}`. */
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Which input fields go in the query string rather than the body. */
  query?: string[];
  /** True when this changes something: the caller sends an idempotency key and, sometimes, a version. */
  operates?: boolean;
  /** True when RES-01 names this as depending on the report a decision was read from (ADR 0074). */
  versioned?: boolean;
}

const project = { type: "string", description: "The project's slug." } as const;
const finding = { type: "string", description: "The finding's numeric id." } as const;
const error = {
  type: "string",
  description: "The error's identifier, as `list_errors` gives it.",
} as const;
const why = {
  type: "string",
  description:
    "Why you are doing this. Required when authenticating with the shared administration " +
    "password, which cannot say who you are.",
} as const;

export const tools: Tool[] = [
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
          description:
            "What to order the endpoints by: `environment`, `endpoint`, `requests` (the default), `errors` " +
            "(the share of requests that returned 5xx), `p50`, `p95`, `p99` or `max`. By the measurement, " +
            "not by the text it is printed as, and a route with no requests is last on every measurement.",
        },
        order: {
          type: "string",
          description:
            "`desc` or `asc`. By default the worst first for a measurement and alphabetical for a name, " +
            "which is what the page does on the first click.",
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
      "The report of a finding: facts, hypotheses with their state and evidence, recommendations tied to " +
      "the hypothesis they rest on, and everything it cannot say. Start here.",
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
        since: { type: "string", description: "RFC 3339 instant of the intervention. Required." },
      },
      required: ["project", "finding", "since"],
    },
    method: "GET",
    path: "/api/p/{slug}/findings/{id}/verification",
    query: ["since"],
  },
  {
    name: "read_history",
    description: "What a project looked like further back than the fine-grained data goes, hour by hour.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        from: { type: "string", description: "RFC 3339 instant." },
        to: { type: "string", description: "RFC 3339 instant." },
      },
      required: ["project", "from", "to"],
    },
    method: "GET",
    path: "/api/p/{slug}/history",
    query: ["from", "to"],
  },
  {
    name: "list_errors",
    description:
      "Every error this project has observed, from the first one: its identity, how many times, when it " +
      "was first and last seen, and in which environments, versions and routes. `kind` says how the " +
      "instrumentation came to see it — an instrumented operation failed, the framework turned it into a " +
      "5xx, the application reported it itself, or the process threw it outside any request. No traffic " +
      "minimum and no detector involved — an error is an observed fact, a finding is a detected " +
      "difference, and the absence of a finding about an error says nothing either way.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        limit: { type: "number", description: "How many to return, 1 to 200. Fifty by default." },
        state: {
          type: "string",
          description:
            "Which triage states to list: `waiting` (the default — open and reappeared, the ones waiting " +
            "for somebody), `open`, `resolved`, `ignored`, `reappeared` or `all`. Whatever you ask for, the " +
            "answer says which filter it applied and how many errors it is not showing.",
        },
      },
      required: ["project"],
    },
    method: "GET",
    path: "/api/p/{slug}/errors",
    query: ["limit", "state"],
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
      "one that is already resolved is refused, because it would overwrite who resolved it.",
    inputSchema: {
      type: "object",
      properties: { project, error, why },
      required: ["project", "error"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/resolve",
    operates: true,
  },
  {
    name: "ignore_error",
    description:
      "Take an error out of the default list until a moment you choose, after which it comes back on its " +
      "own. It silences no detector and no alert, and every occurrence is still counted: no news must never " +
      "be able to mean nothing is happening. An error that is already resolved cannot be ignored.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        error,
        until: { type: "string", description: "RFC 3339 instant, at most thirty days away. Required." },
        why,
      },
      required: ["project", "error", "until"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/ignore",
    operates: true,
  },
  {
    name: "unignore_error",
    description: "Bring an ignored error back into the default list before its time is up.",
    inputSchema: {
      type: "object",
      properties: { project, error, why },
      required: ["project", "error"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/unignore",
    operates: true,
  },
  {
    name: "annotate_error",
    description:
      "Say what you know about an error and Downtrace could not measure: 'only with the legacy checkout', " +
      "'the provider confirms an incident'. It is kept beside the evidence and never on top of it — it " +
      "moves no state and changes no measurement.",
    inputSchema: {
      type: "object",
      properties: { project, error, note: { type: "string", description: "What you know. Required." } },
      required: ["project", "error", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/errors/{id}/annotations",
    operates: true,
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
    description: "One capture and whatever evidence has arrived, with both of its coverages.",
    inputSchema: {
      type: "object",
      properties: { project, capture: { type: "string", description: "The capture's id." } },
      required: ["project", "capture"],
    },
    method: "GET",
    path: "/api/p/{slug}/captures/{id}",
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
      "it is queued, and nothing recovers detail that was not kept.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        environment: { type: "string", description: "The environment to watch." },
        method: { type: "string", description: "HTTP method of the route, when watching a route." },
        route: { type: "string", description: "Route template, when watching a route." },
        kind: { type: "string", description: "Dependency kind, when watching a dependency." },
        target: { type: "string", description: "Dependency target, when watching a dependency." },
        windowSeconds: { type: "number", description: "How long to watch for." },
        why,
      },
      required: ["project", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/captures",
    operates: true,
  },
  {
    name: "close_finding",
    description:
      "Close a finding by hand, with one of the three reasons the product allows. This is not observed " +
      "recovery and is never presented as one.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        reason: { type: "string", description: "expected | noise | resolved-without-telemetry" },
        why,
      },
      required: ["project", "finding", "reason", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/close",
    operates: true,
    versioned: true,
  },
  {
    name: "accept_reference",
    description: "Accept the current behaviour as the new normal for this finding.",
    inputSchema: {
      type: "object",
      properties: { project, finding, why },
      required: ["project", "finding", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/accept-reference",
    operates: true,
    versioned: true,
  },
  {
    name: "assess_hypothesis",
    description: "Record your own reading of a hypothesis. It sits beside Downtrace's and never overwrites it.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        hypothesis: { type: "string", description: "The hypothesis' stable id." },
        state: { type: "string", description: "supported | weakened | discarded | not-assessed" },
        why,
      },
      required: ["project", "finding", "hypothesis", "state", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/hypotheses/{hypothesis}/assessment",
    operates: true,
    versioned: true,
  },
  {
    name: "give_feedback",
    description:
      "Rate a finding on the two axes: was the diagnosis right, and was the alert worth having. It changes " +
      "nothing about the finding.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        accuracy: { type: "string", description: "correct | partial | incorrect | not-assessable" },
        usefulness: { type: "string", description: "useful | unnecessary" },
        by: { type: "string", description: "Who is saying it." },
      },
      required: ["project", "finding"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/feedback",
    operates: true,
  },
  {
    name: "annotate_finding",
    description:
      "Say what Downtrace could not measure: 'reverted at 15:02', 'the provider confirms an incident'. " +
      "Also acknowledge, hand back, or reopen a finding that was closed by hand.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        finding,
        kind: { type: "string", description: "note | acknowledge | unacknowledge | reopen. Default note." },
        note: { type: "string", description: "What you know. Required." },
      },
      required: ["project", "finding", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/findings/{id}/annotations",
    operates: true,
  },
  {
    name: "record_regression",
    description:
      "Record something Downtrace did not detect. Nothing reads these yet; they are the record of what the " +
      "detector missed.",
    inputSchema: {
      type: "object",
      properties: { project, note: { type: "string", description: "What happened. Required." } },
      required: ["project", "note"],
    },
    method: "POST",
    path: "/api/p/{slug}/regressions",
    operates: true,
  },
  {
    name: "silence_alerts",
    description:
      "Stop being told about something, with a scope and an end. It silences the alert, never the detector: " +
      "the finding still opens and still counts.",
    inputSchema: {
      type: "object",
      properties: {
        project,
        scope: { type: "string", description: "project | footprint" },
        until: { type: "string", description: "RFC 3339 instant, at most thirty days away." },
        why,
      },
      required: ["project", "scope", "until", "why"],
    },
    method: "POST",
    path: "/api/p/{slug}/silences",
    operates: true,
  },
  {
    name: "lift_silence",
    description: "End a silence before its time.",
    inputSchema: {
      type: "object",
      properties: { project, silence: { type: "string", description: "The silence's id." } },
      required: ["project", "silence"],
    },
    method: "DELETE",
    path: "/api/p/{slug}/silences/{id}",
    operates: true,
  },
];

export function toolNamed(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
