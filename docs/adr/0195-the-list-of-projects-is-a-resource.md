# 0195 — The list of projects is a resource, and the front page's gate opens in the two shapes the product uses

Estado: aceptado · Fecha: 2026-09-27 · Alcance: público

## Context (gh-688)

The list of projects has no resource in the API. It is the front page of the administrator, and it says, per
project, how many findings it has open, when its last batch arrived, and, since gh-634, whether anything of it was
compared in the last hour. Measured on `origin/main`: `GET /{$}` is the only read that calls
`store.ProjectSummaries` (`cloud/internal/httpapi/pages.go`), and `routes()` registers no `GET /api/…` that lists
projects. Per project, `GET /api/p/{slug}/status` already says `findings.open`, `lastReceivedAt` and the window
without requests — but the slug has to be known before it is asked.

Invariant 13, «the same for people and for agents», asks that every capability of the interface have programmatic
access with the same semantics, and the package that carries the tools says a capability missing there is a bug and
not an omission (gh-281). The front page is a capability of the interface.

One thing the measurement found: the gate that protects the front page, `administrator`, accepts the shared
administration password only in the shape a browser sends it — Basic auth with the user `admin`. A program sends a
Bearer token, which is the shape the MCP server already uses for every other capability. The key existed; a program
could not present it.

## Decision

**1. The list is a resource, not a field of something that exists.** Nothing that exists is about every project:
every route that is, is about the one its `{slug}` names, and a cross-project list under one of them would put
everybody's numbers under one project's path. `GET /api/projects` it is.

**2. It opens with the administrator's key and with no other.** The front page opens with no other, and the page is
the surface being mirrored. A project's credential — whatever its level, `admin` among them — cannot list the
others: that they exist is not information the holder of another project's credential is owed, the reading gh-184
already gave to a project the caller may not see.

**3. The program presents the same key in the shape it already sends.** `administrator` accepts the shared
administration password as Basic auth — the browser — and as a Bearer token — the program, the one the MCP server
sends for every other capability. The key is the same and the gate is the same; what changes is that the key can be
presented over the wire, which is what invariant 13 asks. The check is constant-time, as the Basic one is. The gate
protects the front page too, and a Bearer token opens it with the same key it opens the resource: the gate gained a
shape, not a key.

**4. The resource carries what the page says, with the page's word.** Each project carries its `slug`, its `name`,
its `openFindings`, its `lastReceivedAt` — `null` when nothing ever arrived, which is not the same as a quiet
project (invariant 14) — and the word of the page's column: `N open`, `none` or `not compared`. The word is decided
by one function, `openColumnWord`, and the page and the resource both read it from there: one decision, one word,
so the two surfaces cannot drift apart. The order is the page's — the ones with open findings first, then by name —
because it is the store's, and the store sorts it for the page.

The resource declares what every read declares (RES-01). Its scope is how many projects it lists and the window the
word reads over. Its freshness is the newest batch of the projects, `null` when nothing ever arrived at the
installation. And its limits say what `not compared` is and is not — nothing arrived in the last hour, so the
detectors had nothing to compare; not a verdict on health; an open finding stays open however long a project is
silent — and that what a project is losing and what its senders withhold is read per project, in its own status,
not here.

**5. The agent has the tool.** `list_projects` is one of the tools, calling `GET /api/projects` with the same
credential the session carries: the shared administration password opens it, and a project's key does not, which is
the cloud's answer and not the tool's refusal. It is the way an agent that does not know a project's slug learns it.

## Alternatives

**A field of something that exists.** The status of a project is about that project; a cross-project list under
`/api/p/{slug}/…` would make the slug a lie, and adding the list to every per-project answer would repeat it once
per project and tie its version to every other project's data.

**A credential of its own.** A new level or a new key for «list the projects» is a second name for the same thing
the front page already gates: the capability is about every project, and the installation's key is what opens what
is about every project. Inventing a third credential is how two of them start to mean different things.

**Accept the Bearer password at `atLeast`, where every read is gated.** It would open the per-project reads to the
program too, which is the same invariant-13 gap one level down and not this ticket. This decision changes the gate
of what is about every project, and no other surface moves.

**Let the page keep its words and the resource carry only the numbers.** The word is a decision — `none` versus
`not compared` is invariant 14 in a column — and two places that compute it are two places that can drift. One
function, both surfaces.

## Consequences

- `GET /api/projects` is registered behind `administrator`, the same gate as the front page, and a test holds that
  a project's credential, whatever its level, is refused by it.
- `administrator` accepts the shared password as a Bearer token, constant-time, and a test holds the shape a
  browser sends still opens, and does not open anything the key did not open before.
- `openColumnWord` decides the word, and the page's row and the resource's row read it from there; a test walks
  the four shapes — open, compared, silent, never — and asks both surfaces the same word.
- `readPaths` carries the new read, so the RES-01 guard that asks the router which reads exist and fails a read
  that does not declare itself fails this one too if it ever stops.
- `cloud/README.md` carries the line the documentation test of gh-439 asks for, and `list_projects` is in the
  tools, enumerated by the test that checks every journey the interface walks.
- What already left as a page is unchanged; the resource adds no new data to the wire, it adds access to what the
  page already says.
