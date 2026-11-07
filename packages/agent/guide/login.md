# Connect to a cloud: `downtrace login`

Part of the documentation of [`@downtrace/agent`](../README.md).

```sh
npx @downtrace/agent login --project nidus-api --env staging --url https://your-downtrace-cloud
```

It asks a Downtrace cloud for a project and connects a coding agent to it, with nobody else in between: the way `gh
auth login` does, with a device code (RFC 8628). It prints a link and a short code on stderr; the person opens the
link, signs in with GitHub and reads what is asked —the project, the environment, the level of access, that a coding
agent asks it on their behalf, and the address and program the request came from— and approves once. Then it prints,
on stdout:

- an **access credential** for that project, restricted to that environment, with the configuration of
  the MCP server that uses it. It **expires 90 days** after it is handed over; run `downtrace login` again for a new
  one. Every action made with it says it was on behalf of the person who approved it.
- for a **new** project, an **ingestion token** for that one environment, which only sends data and reads nothing, as
  the `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` the instrumentation starts with.

What it prints is shown once. It writes nothing to disk: where it is kept is yours.

| Option | What it is |
|---|---|
| `--project <slug>` | The project: lowercase letters, digits and dashes. A new one is created in the account of the person who approves, and one of theirs is connected again |
| `--env <environment>` | The environment of the token and of the credential, and no other; `production` when not given |
| `--level <level>` | What the access credential may do: `read` (the default) reads the status, findings, reports, errors and captures; `operate` also asks for captures, annotates, closes and accepts findings, triages errors and silences alerts |
| `--name <name>` | The project's name when it is new; the slug when not given |
| `--rotate-token` | For a project that already exists, mint the environment's ingestion token too, replacing the one it has |
| `--url <cloud>` | The cloud, `https://`; `http://` only for `localhost`. `DOWNTRACE_URL` when not given |
| `--json` | Prints the result as JSON (`schema: "downtrace.login/1"`), for a coding agent; `ingestToken` is `null` when none was minted |

For a project that is already the person's, an environment with no token yet gets its first one, which replaces
nothing. An environment that has one keeps it: login hands over a credential and **no ingestion token**, and the token
the deployment sends with stays as it is. With `--rotate-token` it asks for that environment's token too, and the
approval page says plainly that it replaces the one there is. The old token stops working when `downtrace login` collects the
new one, not when the person approves: batches sent with it are refused from then on, and the result says it replaced
one. That is how a token is rotated.

It speaks only to the cloud it was given: a link to approve or an address to send to on another origin is refused, and
nothing the cloud says is printed with the control characters a terminal would act on.

The person can deny it, and a cloud can refuse it: a project of that name belongs to another account, the account
holds as many projects as one may, or the cloud's sign-up is full and keeps the person on its waiting list. Each is
said in the cloud's own words. A cloud whose operator has not opened sign-up says that too, and its operator creates
projects instead.

Exit status of login: 0 approved, 1 not approved (denied, expired, refused, the cloud unreachable or interrupted), 2 a
usage error.
