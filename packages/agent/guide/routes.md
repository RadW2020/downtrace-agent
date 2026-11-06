# How routes are named

Part of the documentation of [`@downtrace/agent`](../README.md). A route is named by the template your framework registered it with, and nothing of the path that carried a value travels; where there is no template, a heuristic collapses what looks like a value.

Express route templates are used when present, and for a mounted router the template is the mount **as it was
registered** plus the route: `app.use("/tenants/:tenant", router)` is `/tenants/:tenant/users/:id` for every
tenant — one route, not one per tenant. A router inside an app that is itself mounted has both mounts:
`app.use("/1", api)` and `api.use(router)`, as Parse Server mounts its routes, is `/1/classes/:className`. That is also what keeps a tenant's name out of the template when it is
a plain word the heuristic below leaves as written. The route a request matched keeps that template when it fails
and the error is answered outside the router that held it: the mount is read from the dispatch that matched the
route, not from the `baseUrl` Express leaves behind. When a mount's pattern cannot be recovered with confidence,
its segments come out as `:param` instead of the values they carried — the requests still group under one stable
route. That happens for a mount registered with a regular expression (there is no pattern to read), for an app
mounted under a router (Express records no prefix in that case), for a request through one of two mounts of the same
app (Express records only the last, and the other is never named after it), for a mount registered before the instrumentation
started — start the agent before the routes are registered, and `--import` does that for you — and for routes
registered on a copy of Express different from the one the agent wrapped (a duplicated dependency). A middleware that
answers under a mount before any route matched — a 401 from `app.use("/tenants/:tenant", auth)` — keeps the mount's
pattern too: the mount is read from the routers the request went through, and the rest of the path, which no route
names, is `(unmatched)`: `/tenants/:tenant/(unmatched)`, whatever was asked after the tenant, and nothing of it
travels. A file served by a static mount that is not `/`, `app.use("/assets", express.static(dir))`, is
`/assets/(unmatched)` the same way. Where the same stretch is matched by two mounts registered with different patterns, or by routers the
walk cannot tell apart, the stretch comes out as `:param` per segment — and so does a mount registered with several paths on Express 4, which keeps no matcher per path.

**A request that no route names is `(unmatched)`.** When Express is answering and no route matched the request and
no mount is left to name it, its route is `(unmatched)`, one per method — `GET (unmatched)`, `POST (unmatched)` —
and nothing of its path travels. That is a 404; a file served by a mount with no route,
`app.use("/", express.static(dir))`; a middleware of the first level that answers, a proxy, a CORS preflight a
`cors` middleware answers, or a gate that says «starting up»; a path asked before the application registered its route; a route registered with a regular
expression, which has no words to be written back; and a middleware that hands an error on to the app's handler
(`express-jwt` rejecting, passport with `failWithError`), which leaves `baseUrl` back at nothing by the time the
handler answers, even when the middleware sat under `app.use("/tenants/:tenant", auth)`. It is named so because
the path of such a request is not a template, and in some applications it is a secret: n8n fires a workflow for
whoever knows the path of a webhook, and a word without digits is a segment no rule of shape can tell from a route's
own words. A scanner's thousand paths (`/.env`, `/wp-login.php`), and the hundreds of files a bundler writes, are
one route and not as many, and they stop competing for the 500 routes of an interval. What is lost is which URL no
route named, and the name of a mount for a middleware that hands an error on; the lasting answer to both is a route
registered with its template. To keep the requests out altogether, the endpoint exclusion matches it like any
other name: `DOWNTRACE_EXCLUDE_ENDPOINTS=(unmatched)`.

Where there is no Express to ask — a server on `node:http` alone, a framework that keeps no routes Downtrace reads —
there is no route to have named the request, and the heuristic is the reserve: a segment that carries a value is
collapsed into `:id`: anything with
an `@` (an email, a handle), a `%` (a percent-encoding), a digit of any script unless the whole segment is a
version (`v1`, `v2`, `v1.2`), a run of 16 or more with an uppercase in it, a UUID, a run of 24 or 32+ hex,
and a bundler's content hash: a file name that ends in a dash, eight letters, digits, `_` or `-` with an
uppercase among them, and an extension (`/assets/en-BAKsNXTF.js` and its `.js.map` are `/assets/:id`), which
every build renames. Its cost is a camelCase word of exactly eight after the last dash: `app-MainView.js` is
`:id` too, while `user-settings.js` keeps its name.
A plain word — a name, a slug, a file name with no number and no hash — travels as written: no rule of shape can tell a
parameter from a route's own words, and the ways to keep it out are an endpoint exclusion, matched against
the template, and minimal mode.

A route registered after the server starts listening is that case until it exists. n8n listens first, answers
«starting up» from a middleware while it migrates, then lets Express answer a 404, and registers
`/webhook/*path` seconds later: a request in that window is `POST (unmatched)`, whatever the webhook's path —
a plain word included — and from the moment the route exists it is `POST /webhook/*path`. The files of n8n's
editor, which it serves with `app.use("/", express.static(dir))`, are `GET (unmatched)` too: from a route per
file, a thousand of them, to one.

**Koa** routes are named by the path the router registered the matched route with: `/users/:id` for `@koa/router` and
`koa-router`, which leave it on the context as `ctx._matchedRoute`. **Strapi 5** runs on Koa and on that router, so a
request to `/api/articles/1` and one to `/api/articles/2` are one route, `/api/articles/:id`, with the prefix of the
router and of the routers it is nested in; nothing of either path travels. The instrumentation finds the Koa your
application loaded in the module cache, wherever it is installed — Strapi brings its own, which under pnpm is not
reachable from your application's root — from the first request on. A route that hands on to the middleware after it
(Strapi's public files and its 404s do) is named by the route, and not by the last middleware that ran. A request
a router dispatched and none of its routes matched — a path nobody registered, or one registered for another
method — is `(unmatched)`, as in Express, and so is one matched by a route registered with a regular expression,
which has no words to be written back: the router leaves the layers it matched on the context (`ctx.matched`) before
it looks for a route, and a request that has them and no template is one that no route named. A Koa application
with no router has no routes to name a request by, and the heuristic names it as it did, and so for what the
instrumentation cannot reach: a Koa that is loaded after the first request (a lazy `import()`), a Koa bundled into one
file with the rest of the application, and a router that leaves nothing of what it matched on the context.

**Next.js** routes are named by the pathname Next matched, as the file system names it: `app/api/products/[id]/route.ts`
is `/api/products/[id]` for every product, and so are `pages/api/…`, pages and the edge runtime — with Next's own
brackets, which is the path of the file that serves it. What Next matched to no route is Next's own `/_not-found`, and no
part of the path travels. Next keeps this on the request, under a symbol it does not document; it was checked on Next
13.5, 14.2, 15.5 and 16.3 with `next start` and, on 16.3, with `output: "standalone"` too, and a version that stops
writing it is named by the heuristic as before. What Next did not route — an asset under `/_next/static`, on some
versions — is the heuristic's too.

**Fastify** routes (4 and 5) are named by the url of the route that answered, as it was registered, plugin prefixes
included: `/api/tenants/:tenant/invoices/:invoice` for every tenant and invoice. Fastify announces each instance it
creates to whoever listens, and the instrumentation adds an `onRequest`, an `onResponse` and an `onRoute` hook to it
through Fastify's own API; nothing of Fastify is patched. What Fastify's 404 handler answered is `(unmatched)`, as in
Express, and no part of the path travels. An instance created before the instrumentation started is not announced to
it and is named by the heuristic: with `--import`, the instrumentation starts before the application loads.

A request made with **`app.inject()`** — how Fastify's testing guide calls an application, with no server listening —
is observed as one the server received: by its template, with the queries, calls and commands it ran, so a suite
written that way is one `downtrace check` can judge. Node's server never sees such a request, so the hooks open and
close it, apart from the code that called `inject()`: what the test does after it is the test's, not the request's.
An application that injects requests in production — a batch endpoint that answers each part with `inject()` — has
each part counted as a request of its own route, with its own work, and the outer request keeps only what it ran
itself.

**Hapi** routes (21) are named by the path of the route Hapi matched, as it was registered, a plugin's prefix included
and with Hapi's own braces: `/api/orders/{id?}` for every order, as Next.js keeps its brackets. Hapi routes a request
in its request class, which it does not export, and the instrumentation wraps it as Hapi's own modules require it — at
load, from Node 22.4, whether the application imported Hapi or required it. Before Node 22.4, which does not announce
what modules require, the instrumentation loads that class itself when it starts, from the Hapi the application
resolves, and wraps it; Hapi's entry, server and routes are left for the application to load. A Hapi that does not
resolve from the application's entry, nor under `check` from the project, is named by the heuristic there. What Hapi's
`notFound` answered is `(unmatched)`, and no part of the path travels. A request made with **`server.inject()`** — how
Hapi's guide and Lab call an application — is observed as one the server received, as Fastify's `inject()` is: by its
template, with what it ran, apart from the code that injected it, also in a suite that only injects. Under `check`, a
Hapi server that answered a request declares its routes, its plugins' included and in the same form, so a route no
test called is named `not-called`; a route for every method (`*`) has no single name and is not.

**Hono** routes (4) are named by the path of the first route the request matched that is not a middleware, as it was
registered, the prefixes of `app.route()` and `basePath()` included: `/v1/users/:userId` for every user. A middleware is
what `use()` registers: every method, on a path ending in `*`. A request only middleware matched is `(unmatched)`, and no
part of its path travels. This holds for a request served by `@hono/node-server` and for one made with
**`app.request()`** — how Hono's testing guide calls an application, with no server listening — which is observed as one
the server received: by its template, with the queries, calls and commands it ran, opened when its first handler runs
and apart from the code that called it. Three things the second way cannot see: a request no handler matched at all, no
route and no middleware, runs nothing of the application's and is not observed (a logger or CORS registered with
`app.use()` is enough); the time is until the response is returned, not until a streamed body ends; and when the first
handler to run throws, Hono's error handler answers after it, out of reach, so the status is the error's own for an
`HTTPException` and 500 for anything else — what Hono's default handler answers, and not what an `onError` of your own
does. Behind a middleware, your `onError` answers inside Hono's chain and its status is seen. An application that hands
Hono a router of its own (`hono/tiny`, `new Hono({ router })`) gives it its routes as it registers them, which, for the
ESM copy, is after the wrappers are in in practice and not by construction.

A request can carry the template of more than one framework — a Next.js custom server behind Express answers with Express's
catch-all route, a Koa application called from an Express route — and the innermost one names it: Next.js, then Koa, then
Hono, then Fastify, then Express.

## On Node 18

From Node 18.19, every framework above names its routes as it does on the newest Node, in each version of it that runs
there. CI starts the same application, a route with a parameter and one that fails, on each framework from the packed
package with `--import`, on Node 18.19.0 and on Node 24, and both name the same routes: Express 4.22 and 5.3, NestJS
10.4, Fastify 4.29 and 5.12, Koa 2.16 with `@koa/router` 12 (Strapi 5's) and Koa 3.3 with `@koa/router` and
`koa-router` 13.1, Hapi 21.4, served and only injected, Hono 4.13 on `@hono/node-server` 1.19, and Next.js 15.5. These
ask for a newer Node:

| Version | Needs | The last for Node 18 |
| --- | --- | --- |
| Next.js 16 | Node 20.9 | 15.5 |
| NestJS 11 | Node 20 | 10.4 |
| `@koa/router` and `koa-router` 14 | Node 20 | 13.1 |
| `@hono/node-server` 2 | Node 20 | 1.19 |

## What is wrapped

- HTTP requests are observed through Node's `diagnostics_channel`, without touching your code. To count queries per
  request the instrumentation does wrap one method, `pg`'s `Client.prototype.query` (and, for MySQL, `mysql2`'s `query` and
  `execute` and `mariadb`'s `query`, `prepareExecute` and `batch`, for SQL Server `tedious`'s `makeRequest`, and for MongoDB the driver's `Connection.prototype.command`): it passes arguments, results and errors through untouched, and if the wrapper itself fails your query still
  runs. `DOWNTRACE_INSTRUMENT=none` disables it.
- For Express route templates the instrumentation wraps two more methods. The first — `Router.prototype.use`, or the
  `Router` function's own `use` in Express 4, where it is the routers' prototype — keeps the pattern of
  each mount, because Express discards it as soon as it compiles it: without the pattern, a mount with a
  parameter would reach the template as its value. The second — `Route.prototype.dispatch` — keeps the mount a
  matched route saw, because Express restores `req.baseUrl` before an app-level error handler answers, so without
  it a 5xx would reach the template with the wrong mount. Both wrappers are put in place when the instrumentation
  **starts** — with `--import`, before your application registers anything — and not when the package is imported: an
  import with the instrumentation not running loads no Express and touches nothing. They pass arguments, results and
  errors through untouched, and a failure inside either one runs your application anyway — the mount is then read as
  `:param`, which is the safe side (see Express, above).
- For Koa route templates the instrumentation wraps one more method, `Application.prototype.createContext`, which builds the
  context of each request: it remembers which context belongs to which request, because the template a router matched is
  on the context and nothing leads to it from the request. The wrapper passes arguments, results and errors through
  untouched, is put in place from the **first request** and not at start-up — it looks for the Koa your application has
  already loaded, in the module cache, and loads nothing — and an application without Koa pays for that look once.
  Next.js route templates wrap nothing: the template is read off the request, where Next leaves it.
- For Hono route templates the instrumentation wraps `add` on the four routers Hono ships (`RegExpRouter`,
  `TrieRouter`, `LinearRouter`, `PatternRouter`), and so each handler a router is given. Hono's router hands them their
  routes at its first match, the first request, so those four files — and only those: not Hono's entry, which a tracker
  may hook — are loaded when the instrumentation **starts**, both the ESM and the CommonJS copy, by any process that
  resolves `hono`. The wrappers pass arguments, results and errors through untouched; a failure inside one runs your
  handler anyway and names the request by the heuristic.

## When a version changes route names

Naming more requests by their templates, or collapsing more segments, changes those routes' identities once, at the upgrade: an endpoint whose route was a path is seen as the template it became or as `(unmatched)`, a finding on the old route receives no data and is not declared recovered, and an exclusion written against the old name has to be rewritten against the new one — for Next.js, with its brackets (`/api/products/[id]`). It happened when values in segments started being collapsed; when Koa and Next.js, then Fastify, then Hono started being named by their templates; when a request no route named became `(unmatched)`; and when the rest of the path after a mount that answered became `(unmatched)`. The [CHANGELOG](../CHANGELOG.md) says which version did each.
