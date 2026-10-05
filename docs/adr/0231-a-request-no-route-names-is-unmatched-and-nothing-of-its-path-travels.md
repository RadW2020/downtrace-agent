# 0231 — A request that no route names is `(unmatched)`, and nothing of its path travels

Estado: aceptado · Fecha: 2026-10-05 · Alcance: público

## Context (DT-56, DT-26)

A request that no framework template names was named by the heuristic over the path the client asked for
(`src/routes.ts`): a segment that looks like a value becomes `:id`, and a plain word travels as written. The README
said so as the reserve case, and it said that what Express answers with no route, a 404 or a middleware of the
first level, was read the same way (gh-766, gh-899).

n8n showed what that costs. It listens before it registers its routes: it answers «starting up» from a middleware
while it migrates, then lets Express answer a 404, and registers `/webhook/*path` seconds later. In n8n the path of
a webhook is a secret, because whoever knows it fires the workflow, and the path can be a word with no digit, which
no rule of shape tells from a route's own words. A request in that window, `/webhook/plainsecret`, left the server
inside the route. The same happens outside the start-up with every request no route names: a production n8n sent
more than a thousand distinct routes in an hour, nearly all of them the editor's files and a scanner's paths
(`/.env`, `/wp-login.php`), and the scanners' words competed one by one for the 500 routes of an interval.

DT-26 is the same leak by another way. A middleware under `app.use("/tenants/:tenant", auth)` that rejects with
`next(err)`, whose error the app's handler answers, reaches the end of the response with Express's `baseUrl`
already put back to nothing, so there is no mount to read and the route came from the path the client asked for:
`/tenants/acme-corp/users/:id`. The way to keep the mount's name there is to record it as each layer matches, which
means wrapping Express's `Layer`: a class that is not exported and sits on the hot path of every request.

## Decision

**A request that the framework answering it has no route for is `(unmatched)`, one name per method (`GET (unmatched)`),
and nothing of its path travels** (invariant 5: when in doubt, omit).

1. **Express.** When Express is answering the request (its app is on the request, as `req.app`, and is the function
   with a `handle`) and no template names it, the route is `(unmatched)`. A template is a matched route, or a mount
   still on `baseUrl` when a middleware answered (gh-899): that case keeps the pattern of the mount, as before. What
   is left is a 404, a file served by a mount with no route, a middleware of the first level, a path asked before
   its route was registered, a route registered with a regular expression, and a middleware that hands an error on
   to the app's handler, which is DT-26.
2. **Koa.** When a Koa router dispatched the request (`ctx.matched` is the list of layers it matched, which it
   leaves before it looks for a route) and no route matched, the same. A Koa application with no router has no
   routes to name a request by, and the heuristic names it.
3. **No framework with routes** (a server on `node:http` alone, Next.js's own assets, a router the instrumentation
   cannot read): the heuristic stays as the reserve, because there are no routes to consult. Next.js is unchanged:
   what it matches to no route is already its own `/_not-found`.
4. **`Layer` is not wrapped.** The price of not doing it is accepted: a request whose `baseUrl` came back to nothing
   is `(unmatched)` and does not carry the name of the mount, an authentication that rejects with `next(err)`
   included. Recovering the name later, from the mounts along the path the client asked for and outside the hot
   path, is a separate piece of work.
5. **`(unmatched)` is a route like any other for the rest of the system**: it counts in the 500 of an interval, an
   endpoint exclusion matches it by name, minimal mode sends a digest of it, and the black box carries the name the
   aggregate does. It is not `(other)`, which is what an interval's cap left out; the schema's description of `route`
   says both.

## Alternatives descartadas

- **Keep the first segment and collapse the rest.** The first segment can be the secret, and a 404 and a static file
  stay in as many routes as there are first segments.
- **Name late: resolve the requests with no route against the routes registered after, when the interval closes.**
  It costs memory per request, and leaves the black box with a different name from the aggregate's.
- **Leave it as it is and document it.** It was the state, and the leak was documented in the README; the cost is a
  secret that leaves the server, which is the one thing the instrumentation promises not to do.
- **Wrap `Layer` to keep the mount's name for DT-26.** It is on the hot path of every request, and a class
  that Express does not export.

## Consequences

- **Route identities change, once.** A request that was a path (`/webhook/:id`, `/assets/:id`, a plain word) is
  `(unmatched)`; a finding on the old route receives no data, and an exclusion written against such a path has to be
  rewritten as `(unmatched)`. The README says so, as it did for the values and for the Koa and Next.js templates.
- **The detail of which URL no route named is lost.** The lasting answer is the route's template, which the
  developer registers.
- **What this does not close.** The rest of the path after a mount that answered directly (gh-899) still goes
  through the heuristic, and so does the heuristic's reserve in 3. Both are written in the README.
- **Whoever compares routes by name** (`downtrace check` among them) sees `(unmatched)` as one more name, per
  method, and a name that is not a route: it has no template to open.
- **The protocol does not change.** `route` is still a free string; only its description names `(unmatched)` beside
  `(other)`, and the types generated from it say so.
