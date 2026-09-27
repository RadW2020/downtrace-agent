# 0194 — The place of a frame opens at the first `(`, and an eval frame signs at the place of the evaluated code

Estado: aceptado · Fecha: 2026-09-27 · Alcance: público

## Context (gh-712)

Decision 5 of ADR 0083 takes the directory from every frame of the stack signature: the file and the line are the
structure of the user's own code, and the directory gives away the `$HOME` of whoever built it. `frameOf` in
`packages/agent/src/errors.ts` separated the name of a frame from its place at the **last** `(` of the frame, and
when the path holds a `(` — `Program Files (x86)`, `Copy (2)`, `Projects (old)` — what stands before that `(` is
taken for the name of the function, and the directory comes out in the signature. Measured on `origin/main` with
`stackSignature`, Node 26.8.1:

| frame | signature |
|---|---|
| `at load (/home/alice/Projects (old)/app/src/orders.js:42:11)` | `load (/home/alice/Projects@orders.js:42` |
| `at C:\Users\alice\Copy (2)\app\x.js:1:1` | `C:\Users\alice\Copy@x.js:1` |
| `at load (C:\Program Files (x86)\Shop\app\orders.js:42:11)` | `load (C:\Program Files@orders.js:42` |

How many Node backends run under such a directory is a hypothesis, not something measured here.

The same last-`(` read was measured on the odd frames the ticket names, and they are not all handled well:

| frame | signature |
|---|---|
| `at eval (eval at <anonymous> ([eval]:11:11), <anonymous>:3:7)` | `eval (eval at <anonymous>@[eval]:11:11), <anonymous>:3` |
| `at a (data:text/javascript,f(a){}:1:21)` | `a (data:text/javascript,f@a){}:1` |

An eval frame under a directory with a parenthesis in it leaks the same way. The frames that are handled well
were measured and leave unchanged by the decision below: `async fn (…)`, `new A (…)`, `at [eval]:8:29`,
`at file:///…/main.mjs:2:1`, `at run (node:internal/x:1:1)` and a dependency's frame.

## Decision

**1. The place of a frame opens at the first `(` of the line and closes at its final `)`, when the line holds
one.** The place of a V8 frame is what stands between the `(` that opens after the name and the final `)`, and it
ends in `:line:column`. A name — `fn`, `A.m`, `async fn`, `new A`, `eval`, `<anonymous>` — holds no `(`, measured
on Node 26.8.1, so the first `(` is the place's, and a `(` in the path pairs with its own `)` inside the place.

```
at load (/home/alice/Projects (old)/app/src/orders.js:42:11)    →  load@orders.js:42
at C:\Users\alice\Copy (2)\app\x.js:1:1                         →  x.js:1
```

**2. The place of an eval frame is the one after the last `), ` of it.** An eval frame's place holds two places —
the eval call's and the evaluated code's, `eval at fn (/path/file.js:1:1), <anonymous>:2:3` — and the frame's is
the last one: the place of the evaluated code, where the error was thrown. The read of the place would cross the
`), ` between the two and keep both in the signature, garbled. The cut runs only on a place that opens with
`eval at `, which is how V8 writes an eval frame and nothing else:

```
at eval (eval at <anonymous> ([eval]:11:11), <anonymous>:3:7)    →  eval@<anonymous>:3
```

**3. Every other frame leaves exactly as it did.** A name, a `node:` frame, a dependency's frame, an `async`, a
`new`, an `<anonymous>`, a `file:///` and an `[eval]` frame sign as they did, and a test pins each, so a change
beyond the decision goes red. A frame whose URL holds a raw `(` — a data URL whose code is not percent-encoded —
was garbled by the same last-`(` read, and it now signs stable at the function's name and a run of the URL, which
carries no path and no machine.

**4. Identity: the change is accepted, said, and pinned, as in ADR 0170, 0175, 0180, 0184, 0189 and 0193.** An
error whose stack passes under a directory with a parenthesis in it gets a new signature after the upgrade, once,
and is listed as a new error, newly observed, while the old one stops being seen. So does an error whose stack
holds an eval frame, from the garbled read to the clean one. No other signature moves, and the test that pins the
frames that stay is the check. The changeset says both.

## Alternatives

**Keep the last `(`, and refuse a name that holds a `(`.** It would repair the ticket's case — a name with a `(`
in it is rejected and the read falls back — but it rejects the right name of an eval frame, `eval (eval at …`,
for the wrong reason, and it keeps the eval frame's place garbled, which the measurement puts on the table.

**Read the place from its end alone, the final `:line:column`.** It ends the ticket's case, but a place with no
end — a native frame, `at JSON.parse (<anonymous>)` — and a name that ends in digits and colons would have to be
invented by hand, and the `(` that opens the place is known: it is the first one, because a name holds none.

**Repair only the directory's case and leave the eval frame garbled.** The measurement does not allow it: the
garble is the same read, the cut is two lines, and a signature that holds two places of a frame crossed by `), `
is a defect the fix stands next to.

## Consequences

- The split is one line: `body.indexOf("(")` where `body.lastIndexOf("(")` was, guarded by the line ending in
  `)`, and the cut of an eval frame runs only on a place that opens with `eval at `.
- A test pins the frames that stay — `async`, `new`, `[eval]`, `file:///`, `node:`, a dependency — and the ones
  that move, the ticket's rows and the eval frame, with the machine's name absent from the signature.
- `stackSignature` reads one frame at a time, so the signature of a stack is the join of the frames, and a test
  of gh-697 holds that the message's rules never read it.
- What already left with a directory in the signature stays in the cloud until the cloud forgets it. Nothing here
  removes it.
