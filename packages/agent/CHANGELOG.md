# @downtrace/agent

## 0.9.0

### Minor Changes

- 101af91: The interval, the profile window, the coarse register and the wait a `Retry-After` asks for are now on the
  agent's clock, like every other instant it stamps. Each of them fell back to `Date.now` when no clock was
  given, and the agent never gave one, so they read the wall clock while the requests of a capture were dated
  with `performance.timeOrigin + performance.now()` — two clocks that agree when the process starts and drift
  apart when the wall clock is stepped. The profile's `start` and `durationMs` are rounded to the integer
  milliseconds the contract carries, as the interval's always were, so no batch changes shape.
  
  **Breaking, if you build these yourself**: `IntervalAggregator`, `CoarseRegister` and `Sender` now require a
  clock. `IntervalAggregator` takes an options object, `new IntervalAggregator({ now, maxRoutes })`, instead of
  `(maxRoutes, now)`; `CoarseRegister` and `Sender` take `now` in the options they already had. Pass the same
  clock you pass to the agent as `AgentDeps.now`. Nothing changes for an application that only loads
  `@downtrace/agent/register` or calls `createAgent`.
- 94dfc4b: A capture's evidence may carry `coarse`: the coarse half of the black box, frozen — the last few minutes, second
  by second and per endpoint, plus the process's event loop delay in its own series. The agent now feeds that series
  once a second from the process's own delay readings, and sends the summary with every capture it makes
  (`product.md:122`, gh-629).
  
  The protocol's `patch` segment: 0.9.0 is not published yet, and the guard that keeps the package and the protocol
  one number (ADR 0019) publishes the pending release before the next minor. This addition is part of 0.9.0's
  contract when that release goes out, so the version the world reads moves no further than it already is.
- 34fe86e: Two calls for the errors installing without touching your code cannot see (ERR-02).
  
  `captureException(error, context?)` hands over an error your application handled itself — a `catch` that
  retries or falls back, an error you deliberately turn into a 4xx. The shape is the one your error tracker
  uses, so replacing the import is the migration; the return is the one difference, because the instrumentation
  has no event id to give. It is attributed to the request being served when there is one and to the process
  when there is not, and it never throws, whatever you pass it.
  
  `expressErrorHandler()` is the one line the «no code» default needs for the exceptions Express turns into a
  5xx: nothing on Express's error path publishes anything a library can listen to, so until now a 500 arrived
  as a status class with no type, message or stack. It records and calls `next(err)` always, so your response is
  unchanged, and it costs nothing per request. An error that declares itself a client's fault is passed on and
  not recorded.
  
  The context is a flat object of at most eight keys, sanitised under the same rule as an error message — a
  number comes out as `?`, and so does a value of which fewer than half the words survive — and withheld whole by
  `DOWNTRACE_MINIMAL=1`, which still leaves the error grouped by its hash. A key has to be a name and survive the
  same sanitiser unchanged, so `order_12345` is dropped rather than sent half-replaced.
  
  What that guarantees is «no identifier, no address, no token»: the sanitising replaces what looks like a value
  and cannot recognise a plain word, so `{ customer: "alice" }` travels whole. Downtrace does not measure users,
  and keeping identity out of a context you write is yours.
  
  Also: the profile's per-endpoint cap now keeps errors ahead of queries. A reported error takes no time at all,
  so ordering by time alone made it the first thing merged into a bucket the protocol labels a query.
- 39f118a: Still protocol 0.9.0: `resources` may carry `droppedExceptions` — the exception events the instrumentation
  discarded because they did not fit in its caps of distinct signatures, the register's window and the
  sender's accumulation while batches do not land, since the previous batch.
  
  An occurrence, never a signature: what did not fit cannot be named without being remembered, and remembering
  is the growth the cap exists to stop. The counters ride the batch and are reset when it lands, like
  `droppedBatches`, so a cloud that never lands batches never lands the count either. This is the number that
  keeps a process that threw 40 distinct exceptions from reading as one that threw 32 — the loss for budget,
  told apart from the absence of errors (COB-01) — and the cloud adds it up per instance, as it adds the batch
  counters.
  
  Additive and optional, as every change to v0 is: an instrumentation that sends none of it is as valid as it
  was, and the cloud says «did not say» rather than «nothing was lost».

### Patch Changes

- 57b39b1: The sanitiser now closes a `‘…’` span where a word ends, as it does for the ASCII `'` (ADR 0192). A `’` between two
  letters is the apostrophe of `it’s` and the span goes on; a `’` with a word character after it, a quote glued to the
  word after it, does not close the span either. Before, any `’` inside the span closed it, so the words after it left:
  `user ‘it’s alice smith’ not found` came out as `user ? alice smith’ not found`, and now it comes out as
  `user ? not found`.
  
  **Error signatures change for these messages, once.** An error whose message carries a `‘…’` span with a `’` inside it
  gets a new signature after the upgrade, and Downtrace lists it as a new error while the old one stops being seen. A
  message with no `’` inside such a span, and any message made only of ASCII, keep their signature exactly, and a test
  checks this against the previous rule.
  
  The cost the rule accepts, said rather than discovered: a value that carries a plural possessive at a word's end
  inside it — the `’` of `users’` — closes the span early, and the words after it leave:
  `the ‘users’ cart’ was empty` comes out as `the ? cart’ was empty`. The README says so.
  
  No export changes.
- f2636e5: The stack signature no longer leaks the directory of a frame whose directory holds a parenthesis. `frameOf`
  separated the name of a frame from its place at the last `(` of the frame, so a path with a `(` in it —
  `Program Files (x86)`, `Copy (2)`, `Projects (old)` — put what stood before that `(` in the signature, the
  directory included: `at load (/home/alice/Projects (old)/app/src/orders.js:42:11)` signed as
  `load (/home/alice/Projects@orders.js:42`, with the `$HOME` of whoever runs it, which is what decision 5 of ADR
  0083 takes from every frame. The place of a frame now opens at the first `(` — a name holds none — and closes at
  the final `)`, and such a frame signs as `load@orders.js:42`.
  
  An eval frame's place holds two places — the eval call's and the evaluated code's — and the read kept both,
  garbled: `at eval (eval at <anonymous> ([eval]:11:11), <anonymous>:3:7)` signed as
  `eval (eval at <anonymous>@[eval]:11:11), <anonymous>:3`. It now signs at the place of the evaluated code,
  `eval@<anonymous>:3`, and an eval frame under a directory with a parenthesis in it no longer leaks it either.
  
  **Error signatures change for these stacks, once.** An error whose stack passes under a directory with a
  parenthesis in it gets a new signature after the upgrade, and Downtrace lists it as a new error while the old one
  stops being seen. So does an error whose stack holds an eval frame, from the garbled read to the clean one. Every
  other frame — an `async`, a `new`, an `<anonymous>`, a `file:///`, a `node:` and a dependency's — signs exactly
  as it did, and a test pins each.
  
  No export changes.
- a05cb43: A failure while recording an outgoing HTTP call or a Redis command no longer reaches the application. Both
  observers recorded from `diagnostics_channel` subscribers with no guard, and Node turns a subscriber's throw
  into an uncaught exception on the next tick: had the recording thrown, the process would have ended. And a
  `fetch` that failed would have rejected with the instrumentation's error instead of its own `TypeError: fetch
  failed`, because its wrapper recorded inside its own `catch`.
  
  Now every subscriber runs behind a guard, the wrapper records inside a `try` and rethrows the application's own
  error, and the failure counts as an internal error of the instrumentation: it is logged at debug, reported in
  `internalErrors`, and at the tenth the instrumentation disables itself, as it already did for a failure while
  observing an incoming request.
  
  Nothing found in the current code makes that recording throw; this closes the boundary before something does.
- 494ac45: A new switch, `DOWNTRACE_SHED`: `nothing` (the default), `fine` or `profile` — the least the instrumentation gives
  up, whatever its own meter measures. It is the benchmark's switch for weighing the fine detail and the profile on
  their own, head to head against the same agent without them; an operator leaves it alone. The meter's behaviour
  without it is unchanged, and an unknown value means the default, as an unknown observer name does.
- 6b7d15f: The sanitiser now takes a word whole when it carries a fragment that follows neither a path, a query nor the host of
  a URL with its scheme: a `#` with something before it and a letter, a digit or an `_` after it. The part before the
  `#` is a host or a scheme, and the part after it is the value, so nothing of the word stays, as a query's word does
  not. Before, this shape left whole: `GET api.example.com#alice failed` came out as it was, and now it comes out as
  `GET ? failed`; `open sms:ops#alice` (which Node's parser reads as a URL with a fragment) as `open ?`.
  
  What is not a fragment keeps its words, because they are structure: a `#` at the start of a word is how V8 names a
  private member — `Cannot read private member #name …` — a ticket or a channel, and a `#` with nothing after it is how
  a language is named, `C#`. The one shape the rule cannot tell from a fragment is `Object#method`, the same shape with
  a method name after it, and it goes.
  
  **Error signatures change for these messages, once.** An error whose message carries a word with a `#` that has
  something before it and a word character after it gets a new signature after the upgrade, and Downtrace lists it as a
  new error while the old one stops being seen. A message made only of ASCII keeps its signature exactly unless it
  carries a URL, a backtick, a word with a `/` or a `\` in it, a special scheme's name and colon, a word with a `?` and
  a word character after it, a word with such a `#`, or an apostrophe inside a word or closed off the end of one, and a
  test checks this against the previous rules.
  
  No export changes.
- feca86f: A mounted Express router carries its pattern, not its value, to the route. `app.use("/tenants/:tenant",
  router)` with `router.get("/users/:id")` is `/tenants/:tenant/users/:id` for every tenant — one route, not
  one per tenant, and the tenant's name stops leaving in every batch.
  
  This is not the heuristic's to do, and it was not going to: a slug like `acme-corp` passes every shape rule
  and travels as written, and no rule of shape can tell it from a route's own words (invariant 5). The
  protection is the mount's pattern, and for that the agent has to keep it where Express throws it away.
  Express compiles each mount into a matcher and discards the path, leaving only per-request state that
  carries the value last matched; the agent therefore wraps `Router.prototype.use` — it passes arguments and
  the new layers through untouched, and a failure inside it runs your application anyway — and records the
  pattern when the mount is registered. At request time the route is built from the routers themselves: the
  mount chain is read from the request's own app, each link is verified by the matcher Express compiled for
  it, and a literal mount is read as it was written.
  
  When the pattern cannot be recovered with confidence, the segment comes out as `:param`, never as the value
  it carried: a mount registered with a regular expression, an app mounted under a router (Express records no
  prefix in that case), and a route registered on a second copy of Express. `:param` is a stable identity —
  every request to the mount groups under one route — and it changes once for a route that carried a value
  before: a finding on the old per-value route receives no data and is not declared recovered (invariant 14),
  and an exclusion written against it has to be rewritten against the template. The protocol does not change:
  the route is still a normalised template, and the cloud reads nothing new.
- 73c1360: The sanitiser now takes a query that follows neither a path nor the host of a URL with its scheme, in an error message
  and in a value of the context of `captureException`, where it used to let it through whole. A word in which a `?` has
  a letter, a digit or an `_` after it goes, all of it, and a `?` takes its place:
  
  - a host with no scheme and its query: `GET api.example.com?name=alice failed` comes out as `GET ? failed`;
  - a query on its own: `no handler for ?name=alice` comes out as `no handler for ?`;
  - the query of a scheme that is not special, with no `//` after it, which Node's URL parser reads as a URL with no
    host: `open sms:ops?body=alice` and `open mailto:ops@cliente.com?subject=alice` come out as `open ?`.
  
  A `?` at the end of a word, on its own, or with nothing but punctuation after it stays: `unexpected token?` is left as
  it was, and `VALUES (?,?,?)` still comes out as `VALUES (?)`. A word glued to a closed quote goes too:
  `user 'alice'smith not found` comes out as `user ? not found`.
  
  **Error signatures change for these messages, once.** An error's identity is the hash of its sanitised text, so an
  error whose message carried a word with a `?` and a letter, a digit or an `_` after it gets a new signature after the
  upgrade, and Downtrace lists it as a new error while the old one stops being seen. Most were one error per value,
  `no handler for ?name=alice` and `no handler for ?name=bob` being two, and they now group into one. A quoted SQL
  identifier with such a word in it gets a new label and a new query fingerprint the same way. A message made only of
  ASCII keeps its signature exactly unless it carries a URL, a backtick, a word with a `/` or a `\` in it, an apostrophe
  inside a word, a closing quote with a space before it, or a word in which a `?` or a closing quote has a letter, a
  digit or an `_` after it, and a test checks this against the previous rules.
  
  No export changes.
- 804ae24: When the framework does not name the route — outside Express, and inside it for whatever the router answers
  before a route matched, a middleware's 401 or a 404 — the heuristic no longer copies every segment that is
  not a number, a UUID or a long run of hex. A segment that carries a value becomes `:id` whole, so the value
  stops leaving in every batch: an email, raw or percent-encoded, a handle, a phone, a token with and without
  a digit, a file name with a number, a JWT. The shapes are the ones a rule of shape can tell from structure:
  anything with an `@`, anything with a `%`, anything with a digit of any script unless the whole segment is a
  version, a run of 16 or more letters, digits, `_` and `-` with an uppercase in it, a UUID, and a run of 24 or
  32+ hex characters.
  
  **Route identities change for these routes, once.** An endpoint whose route carried a value is seen from
  now on as the template it became, and the old route stops being seen. What hangs off the route hangs off the
  template: a finding on the old route receives no data and is not declared recovered — no data is not no
  error, invariant 14 — and is closed by hand, with one of the reasons a person may give; a reference belongs
  to the route it described; and an exclusion written against a collapsed segment,
  `DOWNTRACE_EXCLUDE_ENDPOINTS=/files/*.pdf`, stops matching and has to be rewritten against the template,
  `/files/*`. What starts being observed leaves without the value.
  
  Versions stay, so `v1` and `v2` remain two endpoints, and a long kebab-case name stays a route. The cost,
  named so that changing it is a decision and not an accident: a technical word with a digit (`oauth2`, `s3`,
  `2fa`, `sha256`) and a long camelCase name (`user.getProfileWithSettings`) become `:id`, which merges two
  routes only when they differ in that segment alone. A plain word — a name, a slug, a file name with no
  number — is still not a value to any rule of shape, and it travels as it did: no rule of shape can tell a
  parameter from a route's own words, and the lasting answer for one is the template the developer writes.
  
  In minimal mode the digest is of the collapsed route, so what the heuristic now folds stops entering it. The
  limit is the plain word, which still does, and can be confirmed by whoever guesses it, the digest being
  keyless and its code public; an endpoint exclusion keeps it out entirely. Express's templates are untouched,
  and the protocol does not change: the route is still a normalised template, and the cloud reads nothing new.
- 1328a20: A second `shutdown()`, and a second `stop()`, no longer resolve the instant the first one is still draining.
  
  The two doors to the way out each forgot what was draining before the drain was done: `shutdown()` took the agent
  out of its module variable before it awaited it, and `stop()` set its `started` flag before the last flush. So a
  second call —from another `SIGTERM` handler, from the self-disable after its tenth internal error— found nothing
  and resolved without waiting for anything. Its caller is usually the one about to `process.exit()`, and a promise
  that settles in the instant cuts the first drain's last batch and the evidence of the captures under way: they left
  with the process, and nothing said so.
  
  The second door now waits for the first's drain. `shutdown()` and `stop()` each remember the drain that is under
  way, and a call that finds one returns it instead of starting over or resolving over it, within the same one-second
  deadline the way out already had (ADR 0169). The README's «safe to call twice» now means what it was always meant
  to: nothing the instrumentation was holding is left behind by the call that leaves.
- fb94d91: The sanitiser now ends a URL's host where Node's own URL parser ends it, in an error message and in a value of the
  context of `captureException`. Two shapes used to leave whole:
  
  - a URL whose path follows its host with a `\`, which the parser reads as a `/`:
    `request to https://api.example.com\users\alice failed` comes out as
    `request to https://api.example.com\? failed`. The same goes for a `\` straight after `://`, which leaves
    `https://\?`, and after a port, where the URL used to go whole as `https://?` and now keeps its host and port, as
    one with a `/` does: `https://api.example.com:?\?`;
  - a URL of a special scheme (`http`, `https`, `ws`, `wss`, `ftp` or `file`) with no slashes after its colon, which the
    parser accepts: `https:api.example.com?name=alice` comes out as
    `https:api.example.com?`, and one whose authority is anything but a host and a port keeps only its scheme:
    `https:payroll@localhost` comes out as `https:?`. A word that only ends like one of those schemes is left alone:
    the scheme of `rows:id:desc` is `rows`.
  
  **Error signatures change for these messages, once.** An error's identity is the hash of its sanitised text, so an
  error whose message carried a URL with a `\` after its `://`, or a special scheme with no slashes and something after
  its host, gets a new signature after the upgrade, and Downtrace lists it as a new error while the old one stops being
  seen. A quoted SQL identifier with one of these shapes in it gets a new label and a new query fingerprint the same
  way. A message made only of ASCII keeps its signature exactly unless it carries a URL, a backtick, a word with a `/`
  or a `\` in it, an apostrophe inside a word, a closing quote with a space before it, or a word in which a `?` or a
  closing quote has a letter, a digit or an `_` after it, and a test checks this against the previous rules.
  
  No export changes.
- 1a7156f: The sanitiser now reads an apostrophe as an apostrophe, in an error message and in a value of the context of
  `captureException`. The `'` of `can't` used to open a quote that closed on the opening quote of the value after it, so
  the value sat between two quotes and what followed its space left: `Can't find user 'alice smith' here` came out as
  `? smith?`, and now comes out as `Can't find user ? here`.
  
  - the `'` of an English contraction or possessive (`can't`, `user's`, `I'd`, `I'm`, `you're`, `I've`, `it'll`, in
    either case) opens nothing, so `can't reach the server` travels as written instead of as `can?`;
  - any other `'` inside a word still opens a quote, because a quote glued to a word looks the same:
    `user O'Brien not found` still comes out as `user O?`, and `user'alice' not found` as `user? not found`;
  - a quote closes only where a word ends, so an apostrophe inside a value does not end it:
    `user 'O'Brien smith' not found` comes out as `user ? not found`, where it came out as `user ? smith?`. A quote
    glued to the word after it no longer closes there: `user 'alice'smith not found` comes out as `user ?`.
  
  **Error signatures change for these messages, once.** An error's identity is the hash of its sanitised text, so an
  error whose message carried an apostrophe, or a quote that closed where a word did not end, gets a new signature after
  the upgrade, and Downtrace lists it as a new error while the old one stops being seen. Most of those with a value in
  them were one error per value, `can?alice?` and `can?bob?` being two, and they now group into one. A quoted SQL
  identifier keeps its label, since no quote rule reads one. A message made only of ASCII keeps its signature exactly
  unless it carries a URL, a backtick, a word with a `/` or a `\` in it, an apostrophe inside a word, a closing quote
  with a space before it, or a word in which a `?` or a closing quote has a letter, a digit or an `_` after it, and a
  test checks this against the previous rules.
  
  No export changes.
- fface44: An exception thrown outside a request is no longer counted twice when a batch has to be sent again, and no longer
  lost when it reaches the sender while another batch is in flight.
  
  Each signature now travels with a running total —how many times it has happened since the process started— beside
  its count. When a batch's answer was lost, on a slow cloud or past the five-second timeout, the retry used to carry
  the old count added to what came after, and the cloud counted the part it already had again; with the total it
  counts only what is new. The instrumentation keeps totals for up to 256 signatures over the life of the process;
  past that, a signature is sent as before and the cloud says its count may include a resend.
  
  And when a batch landed it used to empty everything it was holding for the next one, including the exceptions and
  the capture requests of local signals that had arrived while it was in flight. It now takes off only what it
  carried. Requires a cloud that accepts protocol 0.9.0.
- 3399827: An instant that leaves in a batch is an integer again, so the cloud stops refusing it.
  
  The batch contract writes an instant as an integer count of Unix milliseconds. Since every instant the agent
  stamps started coming from `performance.timeOrigin + performance.now()`, the two fields sealed straight from
  that clock — a capture's effective start and a local trigger's `observedAt` — carried decimals. The cloud
  validates every batch against the published schema, so it answered `400`, and a `400` is a batch **dropped**,
  not retried: the intervals, the profile and the exceptions travelling in the same body were lost with it.
  Every batch reporting the start of a capture, and every batch asking for one because the event loop was
  running late, went that way.
  
  Both are now rounded down where the value is put on the wire, which is what the interval's `start` already
  did. The agent goes on holding the instants at full precision: the comparison that decides whether a request
  happened during a capture is unchanged, and rounding down is what makes the start reported in the batch and
  the one sent with the evidence the same millisecond.
  
  No change to the protocol, the schema or the version it speaks.
- a22e528: Documentation only, and it ships in the tarball: the README gains «Beside your error tracker». You probably
  already have one installed and you are not going to remove it the day you install this, so both can run in one
  process — verified against `@sentry/node` 10.75.0 with an ESM application on Express 5, `pg` and `ioredis`.
  What this instrumentation reports does not change with the tracker there, in either load order, and neither
  does its own cost; your tracker's ingestion is not reported as one of your dependencies. **Load
  `@downtrace/agent/register` first**, and the README says why and what the other order costs the tracker. It
  also shows the two `captureException` calls a migration lives with while it lasts, that both Express error
  handlers see the framework's 5xx in either order, and that with a tracker installed how your process ends when
  it dies is the tracker's business and not ours. No code changed.
- 8c7e6db: Nothing the instrumentation sends changes: every error message, context value and query label comes out exactly as
  before, byte for byte.
  
  What changed is how the sanitiser is tested. Most of its rules could be deleted with every test green: the one that
  removes what a message puts between quotes, the UUID rule and the long-run rule among them. Without the quote rule,
  `user 'alice' not found` left the server whole. `src/sanitize.ts` now exposes its rule lists and the loop that runs
  them, internally and not from the package's entry point. A new test takes each rule out in turn and checks that a
  shared case, one per rule, changes. So deleting any rule, or reordering the ones whose order matters, now fails a
  test. The same cases run through the context of `captureException` and the bytes of a batch.
  
  The README now says what the sanitiser does not recognise yet: digits and addresses outside ASCII, quotes other
  than `'` and `"`, backticks, and the path and query of a URL.
- 28fcf05: The invariants the code cites are in English now, and so is the one citation that reproduced them. No code
  changed: the only edit inside the package is a comment.
- ef7e69b: A test-only change: two fixtures under `packages/agent/test/` were Stripe keys written whole — `sk_live_`
  followed by letters and digits — used to check that a context key which is really a value, and a token inside
  an error message, never leave the process. They were not credentials, but GitHub's push protection cannot know
  that, and it refused every sync of the public repository from 2026-09-18 on account of the longer one.
  
  Both are now assembled at run time from parts, so the sanitisers are handed exactly the same strings as before
  and no file carries one whole. Nothing the package ships changed.
- b2aece4: One clock for every instant the agent stamps.
  
  A capture's effective start was read with `Date.now()` while the requests it is compared against were dated
  with `performance.timeOrigin + performance.now()`. The two agree when the process starts and drift apart
  afterwards, so inside a millisecond there was no order between them — and a request made **during** a capture
  could be counted as one from before it, which understates the coverage the evidence reports.
  
  Both now come from `AgentDeps.now`, whose default is the second expression. The dependency is new and
  optional; nothing that constructs an agent today has to change.
- ac419e7: A test-only change: eight files under `packages/agent/test/` built their own `AgentConfig` fixture by hand,
  each a full object literal repeating every field. Adding one field to the type (gh-565's `profileMs`) broke
  all eight with the same one-line fix, repeated eight times — and none of the eight actually tested anything
  about the configuration, since a hand-rolled literal keeps stating an old default even after production's
  changes.
  
  They now build their base `AgentConfig` from `configFromEnv` itself, through a small shared helper
  (`packages/agent/test/support/agent-config.ts`, never published — nothing under `test/` ships), and layer
  only the fields a given test cares about on top with a `Partial<AgentConfig>`. A changed production default
  now reaches every test's fixture on its own instead of on the ninth manual edit somebody forgets.
  
  `config.test.ts` is untouched: it already asserted on `configFromEnv`'s real output rather than a copy of
  it, which is the shape this generalises to the other eight. Nothing the package ships changed.
- 985a3fd: With the instrumentation loaded, what `pg` throws or calls back reaches the application once, as it does without
  it. The callback forms of `client.query` and `pool.connect` called `pg` inside the guard meant for the
  instrumentation's own failures, and that guard called `pg` a second time when the throw was the application's: on
  an ended pool, `pool.connect(cb)` or `pool.query(sql, cb)` with a callback that rethrows its error ran that
  callback twice. Now `pg` is called once, after the guard, in every form, as the promise forms already were.
  
  Reading where a client points also moved behind the guard: a client whose `host` could not be read threw into the
  application's own query.
- 79c6c9c: A failure while recording a `pg` query or the wait for a connection now counts as an internal error of the
  instrumentation, as a failure while recording outgoing HTTP or Redis already did: it is logged at debug, reported
  in `internalErrors`, and at the tenth the instrumentation disables itself. Until now it was only logged, so a
  failure that repeated on every query made the queries disappear from the data with nothing to say why.
  
  And a client whose `host` getter threw a value with no prototype no longer reaches the application: recording the
  wait described the failure with `String`, which throws on such a value, so `pool.connect()` rejected with a
  `TypeError` instead of handing over its client, and `pool.connect(cb)` let it escape into the driver.
- b9052cd: The published READMEs now say what `product.md` already promised and the package pages did not: this is a
  closed free pilot, with no plans, no billing and no SLA, and an ingestion protocol at `v0` that can still
  change between minor versions. The notice sits under the title, where somebody landing on the npm page reads
  it without scrolling.
- 7e5c49d: The product definition these packages cite is now in English, and so are the citations. Nothing executable
  changed: the schemas keep every field, type and constraint they had, and the only edits inside `packages/` are
  comments and the `description` of each schema property. Those descriptions ship — the JSON schema downloaded
  from npm carried thirteen quotations in Spanish, quoting a document that is no longer written in it.
- 09cccc1: A test-only change: when the capture-window test fails, it now prints the capture's start, its end and the
  instant of every request that came with the evidence. The assertion is unchanged. The failure it exists for
  happened once and said only that two numbers did not match, which was not enough to tell which of the three
  instants had moved.
- 896eb0c: `expressErrorHandler()` hands your own error handler your own error, whatever that error is. It used to read
  the error's `status` and `statusCode` before anything else, outside the instrumentation's guard and even with no
  instrumentation running: an error whose getter threw, or a `Proxy`, reached your handler as the failure of that
  read instead of as itself. Now the middleware reads nothing of the error. Whether it is a client's is decided
  inside the instrumentation, behind its guard, where a failure to read it counts as an internal error and
  nothing is recorded; with no instrumentation running, the error is not read at all.
  
  And a failure of the instrumentation that cannot be described —a getter of your error or of a
  `captureException` context that throws an object with no prototype, a revoked `Proxy`, an `Error` whose `stack`
  cannot be read— no longer escapes the guard while it is being written to the debug log: `captureException`
  returns, and the middleware calls `next` with your error. The failure is counted either way.
  
  Which errors are passed on without being recorded does not change: `status` or `statusCode` from 400 to 499.
- cb7b07e: A test-only change: the assertion that ten thousand events take under fifty milliseconds moved out of the
  fast suite and into `aggregator.measure.test.ts`, which `make bench-measure` runs on a quiet machine and CI
  does not run at all. Nothing the package ships changed, and the number did not move either.
  
  It is where ADR 0114 had already put every other assertion of its kind, and it stayed behind only because the
  mechanism — the file's name, and a `vitest.config.ts` that excludes it — existed in one package. It failed
  under load, 1 of 10 full-suite runs, which is the failure ADR 0032 described when it took the benchmark out
  of the pipeline.
  
  What is left in the fast suite is the half that is about the code: ten thousand events counted into the five
  endpoints they belong to. And a new test enumerates the suite from the directory and fails if any file in it
  bounds a measured duration again.
- 29ec84d: The overhead budget is measured after every merge that can move it, on a runner with nothing else on it, and
  never as a gate before one; the READMEs said it was only ever run by hand. Each run keeps its report, so what
  the instrumentation costs across versions is a series and not a number somebody remembers.
  
  A report now also says **which machine measured it** — cores, memory and processor — because a runner pool
  decides that per run, and one measured from a copy of another repository names the commit it was copied from,
  because its own resolves nowhere upstream.
- 2368145: `DOWNTRACE_PROFILE_MS` now has a ceiling, derived the same way its floor is (gh-716).
  
  The floor is unchanged: never below `DOWNTRACE_INTERVAL_MS`. The ceiling is two and a half minutes minus
  the interval. It comes from the window that reads the profile: the report's diff reads the last five
  minutes, ending one minute ago, and it counts a profile window on the side where it starts, which is only
  in the store once it has closed and been flushed. For those five minutes to hold a profile that has
  arrived at every phase, two whole windows, each with its flush, must fit in them. Above the ceiling there
  are phases in which the report's window holds no profile that has arrived, and the report said
  `no-profile-after` of a route that was profiled as asked.
  
  A value above the ceiling is clamped to it and said once at start-up; a value below the floor is still
  taken as the floor without being said. The default of one minute is unchanged.
- 70563a3: `DOWNTRACE_PROFILE_MS` sets how long a profile window stays open.
  
  The default is unchanged at one minute, which is what production runs on and what ADR 0017 fixed for the
  project's row budget. What is new is that a process can be told to close its windows sooner — never below
  `DOWNTRACE_INTERVAL_MS`, since the profile rotates on each flush and a shorter window would close on the same
  one.
  
  Shortening it multiplies the profile rows in proportion, and those count against the project's daily budget.
- 27fc7cf: `Reference.routesDropped` says what it counts: the endpoints the reference register had no room for, counted
  once each, a lower bound at the register's cap for how many it may remember — the same words the coarse
  summary's `routesDropped` already used, and now the same count.
  
  The register counted the requests it refused, so one endpoint with no room and a thousand requests published
  as a thousand endpoints without samples, while the evidence said the number was endpoints. It now keeps a
  preallocated table of 256 32-bit summaries of the dropped labels — no text, 1 KiB, in `bytes()` and
  `reservedBytes()` beside the rest of the register's arithmetic — and counts each endpoint once. When the
  table is full, or two endpoints share a summary, the number stops and is a lower bound, the way the coarse
  register's count is (invariant 14, invariant 3).
  
  A schema change to the description and not to the contract: every evidence that was valid still is, and the
  number an older instrumentation sent reads as a lower bound either way.
- 5694922: In minimal mode, the detail of a prearmed route now reaches the capture. The reserve used to keep each
  request under the name the cloud does not know, and each of the three places where the reserve meets a
  capture —the lookup of the reserve for the order's route, the filter against the order, the evidence's
  own naming— withheld a name that had already been withheld. `withheldName` is not idempotent, so a
  doubly withheld name matched nothing, and a capture of an armed route went out with only what the
  shared ring happened to keep.
  
  The name is now withheld once, at the exit, the way the ring's already was: the reserve keeps the
  template as it was served, the same the ring does — the black box never leaves the process — and the
  withholding happens where the name leaves, in the evidence and in the comparison against the cloud's
  order. The arm stays keyed by the name the cloud knows, because that is all the signal that arms it
  can see; the reserve learns the real template from the first request it keeps.
  
  The protocol does not change: the route still travels as the stable digest, and the cloud reads nothing
  new. In normal mode nothing changes.
- 41e4afe: The sanitiser now catches value shapes it used to let through whole, in an error message and in a value of the
  context of `captureException`:
  
  - the path, query and fragment of a URL. The scheme stays, and so does a host with its port, which is what the name
    of a dependency already carries: `request to https://api.example.com/users/alice?name=alice failed` comes out as
    `request to https://api.example.com/? failed`. A URL whose authority holds anything else, such as a user and a
    password, keeps only its scheme: `postgres://payroll:hunter@db.internal/orders` comes out as `postgres://?`, where
    it used to come out as `postgres://payroll:?/orders`;
  - quotes that are not `'` or `"`: `“…”`, `„…“`, `‘…’`, `‚…‘`, `«…»`, `»…«`, `「…」`, `『…』`, closed or not;
  - backticks, the same way. A field that Prisma or MySQL names between backticks now comes out as `?` too;
  - digits, letters and addresses outside ASCII: `user ４８２１ not found`, `could not send to ana@müller.de`, and a
    long identifier with an accent in it, all come out as `?` where the value was.
  
  **Error signatures change for these shapes, once.** An error's identity is the hash of its sanitised text. So an
  error whose message carried one of these shapes gets a new signature after the upgrade, and Downtrace lists it as a
  new error while the old one stops being seen. Most of those were one error per value anyway, `user “alice” not
  found` and `user “bob” not found` being two, and they now group into one. A quoted SQL identifier with one of these
  shapes gets a new label and a new query fingerprint the same way, for example `"tabla_año_2024"` or
  `"Geschäftsführung"`. A message made only of ASCII keeps its signature exactly unless it carries a URL, a backtick, a
  word with a `/` or a `\` in it, an apostrophe inside a word, a closing quote with a space before it, or a word in which
  a `?` or a closing quote has a letter, a digit or an `_` after it, and a test checks this against the previous rules.
  
  No export changes.
- ac32885: The sanitiser now takes a path out of an error message and out of a value of the context of `captureException`,
  where it used to let it through whole: a word with a `/` or a `\` in it goes, all of it, and a `?` takes its place.
  
  - a path with no scheme in front of it: `no route for /users/alice?name=alice` comes out as `no route for ?`;
  - a file path, on either system: `cannot read /home/alice/orders.csv` and `cannot read C:\Users\alice\orders.csv`
    come out as `cannot read ?`. Node's own ESM loader writes one: `Cannot find package 'x' imported from
    /home/alice/app/index.mjs` comes out as `Cannot find package ? imported from ?`;
  - a relative path, and a host with a path and no scheme: `GET api.example.com/users/alice failed` comes out as
    `GET ? failed`. A URL with its scheme keeps its host, as before.
  
  A slash on its own stays, and so does a host with nothing after it. A word that only joins two words with a slash
  goes too: `EIO: i/o error, read` comes out as `EIO: ? error, read`. A path with a space in it ends at the space
  unless it is between quotes.
  
  Your route templates are not touched: they travel as the route, and no rule of a message reads them.
  
  **Error signatures change for these messages, once.** An error's identity is the hash of its sanitised text, so an
  error whose message carried a word with a `/` or a `\` in it gets a new signature after the upgrade, and Downtrace
  lists it as a new error while the old one stops being seen. Most were one error per path, `no route for /users/alice`
  and `no route for /users/bob` being two, and they now group into one. A quoted SQL identifier with a `/` or a `\` in
  it gets a new label and a new query fingerprint the same way. A message made only of ASCII keeps its signature exactly
  unless it carries a URL, a backtick, a word with a `/` or a `\` in it, an apostrophe inside a word, a closing quote
  with a space before it, or a word in which a `?` or a closing quote has a letter, a digit or an `_` after it, and a
  test checks this against the previous rules.
  
  No export changes.
- 3de719e: A failure while recording how long a request waited for a Postgres connection no longer reaches the
  application. `Pool.prototype.connect` recorded that wait with no guard, unlike every query: had the recording
  thrown, the callback form — the one `pool.query()` uses for every query — would have ended the process with an
  uncaught exception, and `await pool.connect()` would have handed the application the instrumentation's error
  instead of a client, a client that never went back to the pool. Now the failure is logged at debug and the
  application gets its callback, its client or its own error, as it already did for queries.
  
  Nothing found in the current code makes that recording throw; this closes the boundary before something does. The
  rest of the change is tests: both forms of `client.query` and of `pool.query()` against `pg`'s real pool, with
  the instrumentation's own code failing. `pg` is now a devDependency of the package, which ships nothing new.
- 20c1829: `shutdown()`, `stop()` and the flush on `SIGTERM`, `SIGINT` and `beforeExit` now wait for the cloud at most one
  second in total, as they were meant to.
  
  The one-second limit bounded the last batch only. Each capture under way then sent its evidence with a timeout of
  five seconds of its own, one after another, so against a cloud that took the connection and never answered,
  `shutdown()` took 6, 11 and 21 seconds with one, two and four captures under way — and a process whose only
  `SIGTERM` listener is this instrumentation's waited all of it before the signal was raised again. It now takes the
  second and no more: the batch and every capture's evidence share it. What has not landed when it passes is dropped,
  and `DOWNTRACE_DEBUG=1` says which — the last batch, if the cloud never answered it, and the captures left without
  their evidence, which then expire in the cloud unless another instance delivers them. When the cloud answers in
  time, every capture still hands over its evidence, as before.
  
  `Sender.flush` and `Sender.sendEvidence` accept an `AbortSignal` as well as milliseconds, so one deadline can cover
  several requests; the new `Deadline` type is exported beside `Sender`. A number behaves exactly as it did, and a
  flush that is not leaving keeps its timeout per request.
  
  The sender's caps are now tested, read from the schema: 6 intervals, 16 capture reports, 32 exceptions and 4 local
  asks per batch. No cap changed.
- bb90922: `shutdown()`, `stop()` and the flush on `SIGTERM`, `SIGINT` and `beforeExit` no longer lose the last batch when
  another flush is already under way.
  
  The sender keeps one batch in flight at a time, and the way out used to give up the moment it found one: the last
  interval, the profile's window, the capture starts and what the application had reported last stayed behind and
  left with the process. It also returned while the regular flush was still sending a capture's evidence, and, with
  the pattern the README recommends —`await shutdown()` inside your own `SIGTERM` handler—, while the batch the
  instrumentation's own signal handler had just sent was still waiting for its answer. A `process.exit()` right after
  cut all of that off. With a cloud that answers in milliseconds that took a shutdown falling in a narrow gap; with a
  slow one, the gap lasted as long as the flush under way.
  
  The way out now lets every flush already under way finish, and then sends its own, all within the same one second.
  If that second runs out while it waits, it sends nothing of its own and `DOWNTRACE_DEBUG=1` says the last batch did
  not land. A flush that is not leaving still waits for nothing.
- f353aff: The README says, per way of ending, what reaches Downtrace and what is lost: a signal and a `process.exit()`
  that waits for `shutdown()` hand over everything the instrumentation was holding; one that does not wait hands
  over nothing of the last flush; an exception nobody caught leaves what had already been sent and takes the
  exception itself with it.
  
  No behaviour changes. What changes is that the contract is written down in one place, each row of it asserted
  by a test with real processes, and that a loss nobody had named is named: a send that fails on the very last
  flush is the one the instrumentation cannot report, because what it lost travels in the next batch and there
  is none.
- Updated dependencies [b0f8b55]
- Updated dependencies [b289861]
- Updated dependencies [1f3ebfa]
- Updated dependencies [f1012c9]
- Updated dependencies [b9052cd]
- Updated dependencies [7e5c49d]
- Updated dependencies [94dfc4b]
- Updated dependencies [7f79d6b]
- Updated dependencies [27fc7cf]
- Updated dependencies [39f118a]
  - @downtrace/protocol@0.9.0

## 0.8.1

### Patch Changes

- db6ccf3: The prearmed detail reaches the capture. Arming worked and nothing else did: the reserve was written with no
  operations, no dependencies and no pool wait, and the one production call that assembles a capture never read
  it. A route armed by pool wait kept rows that said nothing and that nobody looked at.

## 0.8.0

### Minor Changes

- bef32b8: A route whose requests keep queueing for a database connection now arms itself: its fine detail stops being evictable by every other route's traffic for the next couple of minutes. Fifty milliseconds of pool wait per request, sustained across two intervals, over at least twenty requests.
  
  It asks the cloud for nothing — arming is silent and costs a few kilobytes — and it is read from the interval the agent already builds, so it costs nothing per request. Pool wait is the one saturation signal measured per request, so it is the one that can name the route that is suffering rather than the busiest one.
- 2dbcdcd: A route can now be armed so that its fine detail survives other routes' traffic. The fine register is one ring shared by every route, so under load the detail of the route you care about disappears under everything else; an armed route gets slots of its own that nothing else can take.
  
  Nothing arms a route yet — the local signal that does is still to come — so in practice this holds nothing and costs a lookup per request. Preallocated and bounded, it respects the instrumentation's own budget: when the agent is already shedding fine detail, the reserve stops writing too.

## 0.7.0

### Minor Changes

- 2257464: The instrumentation now sends `poolWaitMs` with every captured request: how long it waited for a connection from a pool before it could talk to the dependency at all. It already measured this per request and threw it away when the request ended, so a pool-saturation finding could say something was wrong and never how many requests it reached.
  
  Absent means the request asked no pool, which is not a wait of zero: zero is a request that asked and was served at once. Needs `@downtrace/protocol` 0.8.0, which the cloud has been reading since it shipped.

## 0.6.2

### Patch Changes

- d592205: Fixes a comment in `src/coarse.ts` saying the coarse record exists to be frozen by a capture "which does not exist yet". Captures exist: the instrumentation receives the order, observes, and sends the evidence back. This is a public file, and that sentence was the first thing anyone opening the module read.
- 2e960e3: The README's "What leaves your server" now lists what a capture sends, the reference samples that travel with it, and the instrumentation's own measured resources. The list was true and no longer complete, and an incomplete enumeration in the section somebody reads to answer exactly that question reads as a promise.
- Updated dependencies [74261e9]
  - @downtrace/protocol@0.8.0

## 0.6.1

### Patch Changes

- d68f87d: Refuse a publish that would ship broken entry points. These packages develop pointing at their sources and rely on `publishConfig` to rewrite `exports` and `bin` to `dist/`; npm does not apply `publishConfig` and pnpm does, so `npm publish` from the package directory ships a manifest naming files the tarball does not carry. That is how `@downtrace/mcp@0.1.0` went out unusable. A `prepublishOnly` guard now refuses that publish and says how to do it, and the tarball check verifies that every entry point a manifest names is inside the tarball.
- Updated dependencies [d68f87d]
  - @downtrace/protocol@0.7.1

## 0.6.0

### Minor Changes

- ca2f2d8: Keep the coarse half of the black box in memory: the last five minutes, second by second and per route, with
  requests, errors, latency and calls, plus the process's event loop delay in its own series.
  
  Until now the finest thing the agent kept was the aggregation interval, so a degradation that started and was
  detected inside the same minute had no timeline. This is what makes it possible to see **how** something began.
  
  It never leaves the process — nothing is sent, and the protocol is unchanged. Memory is bounded by construction:
  one preallocated row per route up to 128, and the whole register stays under two mebibytes, which a test asserts
  rather than a comment claiming it.
- ac19643: Errors get an identity, not just a tally.
  
  `product.md` asks the instrumentation to observe «errors and exceptions: type, sanitised message, stack signature», and it only ever counted them. A Postgres query that fails now records an `error` operation beside
  its `query` one, with the type, the sanitised message and the top frames of the stack — file and line kept,
  directory dropped.
  
  The message is sanitised harder than a query's, deliberately: it is the likeliest place in the product for a
  customer's identifier to appear, and a false positive costs a `?` where a word would have read better while
  a false negative cannot be taken back.
- 7ede24b: Exclude whole endpoints and dependencies
  
  `DOWNTRACE_EXCLUDE_ENDPOINTS` and `DOWNTRACE_EXCLUDE_DEPENDENCIES` take comma-separated patterns where `*`
  stands for any run of characters. What they match is not observed at all — not an aggregate, not the black
  box, not the profile, not even the count of requests — and the batch declares **how many** distinct
  endpoints and dependencies were withheld, never which. Endpoints are matched against the normalised route
  template, so excluding `/users/:id` works and excluding `/users/123` does not pretend to.
- 0cfffb7: Keep the fine half of the black box in memory: the last tens of seconds, request by request and operation by
  operation, with the **order** and the **overlaps** that the aggregates throw away.
  
  An aggregate says a route ran fifty-six queries. Only a sequence with starts and ends says whether they ran one
  after another or all at once, and that is the difference between time added to the request and time it spent
  waiting on something it had already asked for.
  
  Two preallocated rings with absolute cursors, so nothing is allocated per request or per operation and the memory
  cannot grow. A request that runs far more operations than the cap is truncated **and says so**, and its writes are
  capped too — a runaway request must not cost its neighbours their detail. When the ring has lapped a request's
  operations, they come back marked as lost rather than as an empty list, which would read as "it ran nothing".
  
  Only the fingerprint travels here, never the text of a query. Nothing leaves the process.
- e31d810: Add `DOWNTRACE_INSPECT`: see exactly what would leave your server, without sending it
  
  Point it at `stderr` or a file path and every batch is written as the exact bytes that would be shipped, one JSON
  line each. With it set, `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` become optional, so an application can be run
  instrumented and inspected before signing up for anything. Set alongside a token and URL it writes and sends, so
  a running deployment can be audited without turning it off.
- 96499ac: The instrumentation now reports its own resources: batches dropped, rejected and failed, internal errors, what it has shed to stay inside its budget, the memory its registers hold and an estimate of its hook time per request. Without them a cloud that sees nothing cannot tell "nothing happened" from "this instrumentation has been throwing batches away".
- 118486b: The instrumentation now asks for a capture when a local signal says the process is in trouble: the p99 of the event loop delay over 250 ms for two intervals in a row. The ask travels in the batch and the order comes back in the answer, on the channel that already existed; the cloud turns it into a capture of origin `automatic`, against the same budget, cooldown and concurrency as any other.
- 8e9d634: `DOWNTRACE_MINIMAL=1`: send no free text at all
  
  Route templates, dependency targets, your hostname and your deployed version travel as stable digests of
  themselves, and query text, error messages and exception signatures do not travel at all. What stays is
  what is not yours — the protocol version, the HTTP method, the kind of each dependency, the counts and the
  timings — so detection and comparison keep working and what is lost is the ability to name things, which
  every report now says instead of showing a bare hash.
  
  What counts as free text was decided by listing every string a real batch carries, not from memory: the
  hostname and the deployed version were in it and had not been thought of. The environment is deliberately
  not withheld, because the ingest token already tells the cloud which one it is.
  
  Also fixed: a process that observed something and left inside the same millisecond produced a profile
  window of zero, which the schema refuses — losing the whole batch and opening a coverage-loss episode over
  a rounding error.
- 9ac9c79: Obey a capture the cloud asks for
  
  The orders have been travelling in the answer to every batch since the control channel landed, and nothing
  read them: `flush` looked at `res.ok` and threw the body away. Now the instrumentation picks the order up,
  starts watching, reports the effective start in the next batch — which CAP-01 keeps apart from when the
  capture was accepted — and sends what the black box holds when the window closes, on the evidence path.
  
  A capture that saw nothing sends empty evidence rather than silence, because a capture with no requests does
  not prove recovery. Every instance obeys and the first to deliver wins: the cloud answers the rest with a
  409, which is not a failure but another process having been quicker.
- 5d86818: Send a class instead of a label for a query the normaliser does not understand
  
  `product.md` says what to do in doubt — omit rather than risk it — and this is that rule for queries. A scan
  that ran off the end of a delimiter it never closed, or met a character it has no rule for, produces no
  normalised text: the operation travels as its hash and one of `select`, `insert`, `update`, `delete` or
  `other`, which the cloud shows as the fourth reason a label can be missing. The hash is still a digest of the
  normalised text, so a query that cannot be labelled is still one operation to group and compare, and
  `DOWNTRACE_QUERY_TEXT=off` keeps meaning what it meant: with the text off, neither text nor class is sent.
- 652118a: Reference samples. The instrumentation keeps a few requests per endpoint — chosen by a uniform reservoir, so the criterion is neither "the fastest" nor "the last ones" — and a capture now carries them with the selection, the population they were drawn from, and whether renewal was paused while the capture was open. A capture used to arrive with the detail of what went wrong and nothing to compare it against.
- af90c9e: Say what is being watched, and what is not
  
  Every batch now carries `agent.observers`: one state per `DOWNTRACE_INSTRUMENT` switch, computed when the
  observers actually attach rather than from what was asked for. `off` is «not asked for», `unavailable` is
  «asked for and could not attach» — a `pg` that is not resolvable from the application's root, which until now
  disappeared into a debug log while the cloud published «this service calls no database». Without this a
  service that does not use Redis and one that uses it unwatched look identical (COB-01, invariant 14).
- ddaedc1: The instrumentation measures what it costs while it runs, and gives ground when it costs too much.
  
  `product.md:241` promised «if it detects that it is itself adding latency, it throttles itself» and nothing measured the
  time spent in the hooks. Now one hook in sixty-four is timed — the others cost an increment and a comparison,
  because measuring the cost cannot be the cost — and when the estimate crosses half of what invariant 3 allows,
  the fine detail goes first, then the profile, and never the aggregate. `AgentStats` gains `shed`,
  `shedReason` and `overheadPerRequestMs`.
- 8489cd3: Send the operation profile: what each route normally runs, not only how it performed
  
  With `pg` instrumented the agent now builds and ships the `profile` section the protocol has accepted since
  0.6.0. Each query's text becomes a normalised label and a stable hash, computed once per distinct query text, and
  the profile rotates once a minute rather than with every interval. `DOWNTRACE_QUERY_TEXT=off` suppresses the
  normalised text and nothing else: the hash is the identity, so the analysis stays whole.
- a965397: `shutdown()`, for an application that calls `process.exit()`
  
  `process.exit()` does not wait for a promise in flight and does not fire `beforeExit`, so an application
  that calls it cuts off whatever the instrumentation was about to send — the interval in hand, the profile of
  the window, the evidence of a capture. `await shutdown()` before exiting hands all of it over. It is safe
  with the instrumentation switched off, safe twice, and never throws.
  
  You do not need it if you let the process end on its own; the README says which case you are in.
- b876605: Tell an invalid batch apart from an unreachable cloud, and obey `Retry-After`
  
  A batch the cloud refuses as invalid (400, 413, 422) is now discarded and counted as `rejected` — reported once —
  instead of being retried until the bounded queue evicts it, where it took a slot from batches that were fine. A
  rejected token (401, 403) still keeps its batch: that is temporary, and those intervals matter once it is fixed.
  A 429 now waits for what `Retry-After` asks, in seconds or as an HTTP date, capped at a day.
- afb1b89: Watch the exceptions that kill the process, without changing how it dies
  
  Uncaught exceptions and unhandled rejections are reported with their type, sanitised message and stack
  signature, counted per signature. They are watched through `uncaughtExceptionMonitor`, which Node calls
  before any real handler and which does not count as handling the exception — a plain
  `process.on("uncaughtException")` turns exit 1 with a stack trace into exit 0 with nothing, and one that
  rethrows gives 7. Two processes, one instrumented and one not, are compared in a test.
  
  If the process dies the exception is lost: sending is asynchronous and an uncaught exception does not go
  through `beforeExit`. It arrives when your application survives what it threw, which the README says
  plainly rather than promising otherwise.

### Patch Changes

- d1c1e32: A capture now sends what its order asked for. It used to hand over the whole fine register — every route's name, timing and composition — and count both coverages over all of it. Filtering by dependency needed the black box to keep, per request, which dependencies it touched.
- b7d1cb3: Obey the capture orders the cloud sends. The parser required a number where the contract writes a date, so every order was dropped in silence; and the fine register dated requests with the process clock, so the evidence dated them to 1970 and counted none of them as observed.
- 6877734: Send the profile of a process that did not live a whole minute
  
  The profile's window is a minute wide, for a row-budget reason that has not changed, and `rotate` looked at
  the clock — so shutting down before the minute was up threw away everything the instrumentation had learned
  about what the routes run. A process that keeps restarting is exactly when that matters, and the last
  incomplete minute of every process went the same way. Leaving now closes the window whatever the clock says,
  and the partial window declares the duration it really had.
- 93d0dd1: A capture's evidence now says which request lost its detail or truncated it, not only how many did. The register knew it request by request and only the totals travelled, so a request whose operations had been overwritten arrived with an empty list and read as one that ran nothing.
- 68395bb: In minimal mode a capture's evidence withheld nothing: it copied the route template straight out of the black box. It now goes out as the same digest the batches carry — which also fixes route-scoped captures in minimal mode, whose filter was comparing the cloud's digest against the real template and silently returning empty evidence.
- 07aefad: The dependency key separator is written as an escape instead of a raw NUL byte. No behaviour changes — the
  character is the same one — but the source file stops being binary to git, so its diff can be read in review.
- 51f6510: An error message that says nothing after sanitising is not sent at all.
  
  `product.md` is explicit that when something cannot be processed with guarantees it is omitted rather than
  risked, and the error signatures added in the previous release always sent whatever survived. Now a message
  that comes out mostly `?` is left out — the type and the stack signature still travel — and the text says
  why, rather than leaving a hole.
- 18a259f: Sanitise what a double-quoted SQL identifier carries
  
  A quoted identifier is structural metadata and keeps travelling — it is what makes the label readable — but
  invariant 5 asks for that metadata sanitised, and it was going out verbatim. A name is not always written by
  whoever wrote the query: `SELECT * FROM "${schema}"` builds one from data, and a doubled quote is part of the
  name in SQL, so a whole literal can hide inside one. The same patterns and threshold as an error message now
  apply to it, and a name of which fewer than half the words survive travels as `?`. A name with no values in
  it is unchanged.
- 4a62489: Send a profile even when there is no interval to send with it
  
  `flush` asked whether the interval queue was empty, and the profile queue is a different queue — so a
  profile with no interval to ride on waited for one that might never come. At shutdown there never is one.
- e350236: Do not let an unterminated identifier quote carry the rest of the query out
  
  `normalizeQuery` swallows to the end of the string when a delimiter opens and never closes, which is why it is
  a scanner and not a chain of regular expressions — but the double-quoted identifier branch emitted what it had
  swallowed instead of `?`, so a query with an odd number of double quotes shipped its remaining literals
  verbatim. Every delimiter now follows the same rule. A closed identifier is unchanged.
- c0efa77: Omit three PostgreSQL constructions the scanner only thought it understood
  
  A dollar-quoted body whose tag is not ASCII (`$étiquette$…$étiquette$`) was not recognised as one, and its
  body travelled word by word; a tag that is not valid at all was emitted rather than omitted; and block
  comments, which nest in PostgreSQL, ended at the first `*/` so the rest of the comment shipped verbatim. All
  three now end where the product says they should — omitted, as a hash and a class.
  
  `ErrorFingerprintCache` also keyed anything that was not an `Error` on `String(err)`, which is
  `"[object Object]"` for every object, so the second thrown object came back with the first one's signature
  and the first one's message. It is keyed on what the signature reads now.
  
  The text of a query that carries a comment changes, and so does its hash: a comment now collapses like the
  whitespace it is instead of leaving a double space.
- b4c7e92: Fix the line numbers these packages cite in `docs/product.md`
  
  Comments only, in both packages: the citations pointed at the wrong line, and in the most repeated case at a
  blank one. No behaviour changes.
- c9c4d0a: Clear the Biome warnings in these packages' tests
  
  Test files only — an unused import and two `any` replaced by the interface the test was already asserting —
  so nothing changes in what ships. The build now fails on a warning rather than printing it (ADR 0089), and
  these were the four in the way.
- Updated dependencies [96499ac]
- Updated dependencies [118486b]
- Updated dependencies [652118a]
- Updated dependencies [b4c7e92]
- Updated dependencies [4a62489]
- Updated dependencies [4a2d5ac]
- Updated dependencies [af90c9e]
- Updated dependencies [8489cd3]
- Updated dependencies [bb48212]
- Updated dependencies [83ec804]
- Updated dependencies [82b845a]
- Updated dependencies [3df94fb]
- Updated dependencies [a23b608]
- Updated dependencies [24699a4]
- Updated dependencies [c934696]
  - @downtrace/protocol@0.7.0

## 0.5.2

### Patch Changes

- 55f89d1: The README and the package's own warnings say **instrumentation** instead of "the agent". Two things in Downtrace could be called an agent — this library, and a coding agent that queries and operates the product — and a message someone reads while debugging is the worst place for that ambiguity. The npm name is unchanged on purpose.
- Updated dependencies [ef6a542]
- Updated dependencies [d61306f]
  - @downtrace/protocol@0.6.0

## 0.5.1

### Patch Changes

- df00701: The README now says what the agent observes — incoming and outgoing HTTP, Postgres with pool wait, Redis and runtime health — instead of claiming it only watches incoming HTTP, which stopped being true several versions ago.
  
  It also warns about the one thing that stops an application from starting. `--import` means nothing in your code imports the agent, so a bundler that ships "only what is used" leaves it out: Next.js with `output: "standalone"` dies at boot with `Cannot find package '@downtrace/agent'` while the dependency sits correctly in `package.json`. The fix for Next is a three-line `instrumentation.ts`, measured on Next 15: the agent starts, finds the application's `pg` and reports queries per route, with no change to the Dockerfile or the start command.
  
  And the agent no longer claims to have instrumented `pg` twice. It never did it twice — the guard was there — but the line was written in two places, and a log that lies costs more than no log.
- Updated dependencies [3f87181]
  - @downtrace/protocol@0.5.0

## 0.5.0

### Minor Changes

- d63ac71: `DOWNTRACE_INSTRUMENT` now takes a list, not just an on/off switch: `all` (the default), `none`, or a selection like `pg,http,redis,runtime`. It exists so each observer's cost can be measured on its own, and it lets an operator run only what they want observed. Unknown names are ignored rather than fatal, so a typo cannot stop the agent from starting.

### Patch Changes

- 8fcaf97: Fixes attribution under connection-pool contention. `pool.query()` uses the callback form of `connect` internally, and pg fires a query's callback from the connection's own context, not the caller's: with ten concurrent requests on a pool of two, all twenty queries were charged to two requests and the other eight reported none. The pool's queued callback is now bound to the request that asked for the connection, and a query's callback records into the request captured when it was issued.
- 42c1db4: Halves the cost of attributing pooled queries: one async resource per connection acquisition instead of two, and none at all for work outside a request. `pool.query()` acquires a connection for every query, so that path is on the hot path of any application using a pool.

## 0.4.0

### Minor Changes

- 27ddb88: The agent now measures how long a request waited for a database connection, and reports it against the same dependency as the queries that follow (protocol 0.5). A connection pool with nothing free is what turns one slow dependency into a whole service degrading, and it is invisible in the query's own duration.

### Patch Changes

- Updated dependencies [662e8f5]
  - @downtrace/protocol@0.4.0

## 0.3.0

### Minor Changes

- 775604a: The agent now reports its dependencies as a list (protocol 0.4), one entry per kind and target, instead of the deprecated `postgres` field. Failed calls are counted as errors against the dependency. Internally the per-request context counts calls per dependency rather than queries, so adding Redis, MySQL or outgoing HTTP is a few lines per driver rather than a new shape each time.
- bdc7af4: Outgoing HTTP: the agent now reports the calls each request makes to other services, grouped by host, with their time and failures. A 5xx from a dependency counts as a failure of that dependency. Nothing is patched: `fetch` and the `node:http` client both publish on `diagnostics_channel`, and the agent only listens.
  
  Known gap: when a `fetch` fails to connect at all, undici publishes nothing, so that call is not seen. The `node:http` client does report it.
- 0853ecd: Redis: the agent now reports the commands each request issues, per server, with their time and failures. Nothing is patched here either, ioredis publishes on a tracing channel.
  
  Every dependency now carries a target that says **which instance** of its kind it is, so a read replica and a primary, or two Redis servers, are two dependencies rather than one. Postgres calls now carry their host and port too.
- 91e0e8a: Runtime health: every interval the agent reports its own event loop delay (p50, p99, max), garbage collection time and count, heap and RSS, and the peak of concurrent in-flight requests (protocol 0.3). It is what tells a saturated process apart from a slow dependency, and it comes from Node's own instruments.

### Patch Changes

- 68d7d86: A `fetch` that fails to connect is now counted as a failed call to that host. undici publishes nothing at all in that case, which is precisely the "dependency is down" case, so the agent wraps `globalThis.fetch` for that one path only: it records nothing when the call succeeds or when the channels already saw it, so nothing is counted twice.
- Updated dependencies [f88b2d3]
- Updated dependencies [831e376]
  - @downtrace/protocol@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [7c267ba]
  - @downtrace/protocol@0.2.1

## 0.2.0

### Minor Changes

- 59fe767: Per-request context and Postgres composition: the agent counts the queries each request makes, their total and slowest duration, and reports the distribution per route (protocol 0.2). It wraps `pg`'s `Client.prototype.query` without any code change in your application, passing arguments, results and errors through untouched. `DOWNTRACE_INSTRUMENT=none` turns it off.

### Patch Changes

- Updated dependencies [1f30299]
  - @downtrace/protocol@0.2.0

## 0.1.2

### Patch Changes

- ef87598: README: document `DOWNTRACE_DEBUG=true`, `http://` URLs and the interval fallback.

## 0.1.1

### Patch Changes

- 7d83e3e: README: state the Node versions the built package is verified on and link the changelog.

## 0.1.0

### Minor Changes

- 1a05394: First public release. Protocol v0 (aggregates schema with fixed-bucket latency histograms) and agent v0: observes incoming HTTP requests via diagnostics_channel, aggregates per route and 10-second interval, ships batches off the request path with a bounded queue, and disables itself on internal errors.

### Patch Changes

- Updated dependencies [1a05394]
  - @downtrace/protocol@0.1.0
