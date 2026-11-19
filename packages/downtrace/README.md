# downtrace

> Your coding agent just introduced an N+1. `downtrace check` catches it before you push.

```sh
npx downtrace init     # finds your test command, writes downtrace.json; asks nothing
npx downtrace check    # exit 0: no route got worse · 1: one did · 2: no comparison could be made
```

This package is the command of [`@downtrace/agent`](https://www.npmjs.com/package/@downtrace/agent) with nothing to install first: it depends on it and runs it. Everything about `check` is said [there](https://github.com/RadW2020/downtrace-agent/tree/main/packages/agent#readme).

MIT.
