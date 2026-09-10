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
      "and the data budget with its consumption.",
    inputSchema: { type: "object", properties: { project }, required: ["project"] },
    method: "GET",
    path: "/api/p/{slug}/status",
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
