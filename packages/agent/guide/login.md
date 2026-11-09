# Connect to a cloud and read it: `downtrace login`, `brief` and `api`

Part of the documentation of [`@downtrace/agent`](../README.md).

```sh
npx @downtrace/agent login --project nidus-api --env staging
```

It asks Downtrace's cloud, or the one `--url` names, for a project and connects a coding agent to it, with nobody else
in between: the way `gh auth login` does, with a device code (RFC 8628). It prints a link and a short code on stderr;
the person opens the link, signs in with GitHub and reads what is asked —the project, the environment, the level of
access, that a coding agent asks it on their behalf, and the address and program the request came from— and approves
once. Then:

- it keeps an **access credential** for that project, restricted to that environment, in `credentials.json` under
  `$XDG_CONFIG_HOME/downtrace` (`~/.config/downtrace` without it), where the MCP server finds it: a coding agent never
  copies it anywhere, and it is not printed. It **expires 90 days** after it is handed over; run
  `downtrace login` again for a new one. Every action made with it says it was on behalf of the person who approved it.
- for a **new** project, it prints an **ingestion token** for that one environment, which only sends data and reads
  nothing, as the `DOWNTRACE_TOKEN` and `DOWNTRACE_URL` the instrumentation starts with. It is shown once: it goes
  where the backend reads it.

On stdout it says what was granted, where the credential was kept, and the configuration of the MCP server, which
names the cloud and no credential.

The file is readable by its user alone (0600), in a directory only they open (0700), and holds one entry per cloud and
project: a new login of the same project at the same cloud replaces the earlier entry, and the others stay. It is
written whole to a temporary file beside it and renamed over it, so nothing ever reads half of one, and a symbolic link
in its place is not followed. Each entry says when it expires: an expired one is not sent, and what would have sent it
says to run `downtrace login` again.

A file that other users can read or write, that belongs to another user or that is a symbolic link is not used, the
way ssh refuses a private key others can read: what reads it says why, and `chmod 600` on the file, or another login,
which writes it 0600, makes it usable again.

When the credential cannot be kept —a directory that cannot be written, or a file login cannot read, which it leaves
as it is— login still exits 0, says why and prints the credential instead, because an approval is collected once. With
`--no-store` it keeps nothing and prints the credential, with the MCP server's configuration that carries it as
`DOWNTRACE_TOKEN`: where it is kept is then yours, and an access credential, `dtr_…`, stays out of a repository.

| Option | What it is |
|---|---|
| `--project <slug>` | The project: lowercase letters, digits and dashes. A new one is created in the account of the person who approves, and one of theirs is connected again |
| `--env <environment>` | The environment of the token and of the credential, and no other; `production` when not given |
| `--level <level>` | What the access credential may do: `read` (the default) reads the status, findings, reports, errors and captures; `operate` also asks for captures, annotates, closes and accepts findings, triages errors and silences alerts |
| `--name <name>` | The project's name when it is new; the slug when not given |
| `--rotate-token` | For a project that already exists, mint the environment's ingestion token too, replacing the one it has |
| `--url <cloud>` | Another cloud, `https://`; `http://` only for `localhost`. `DOWNTRACE_URL` when not given, and without either Downtrace's cloud, whose address `--help` prints |
| `--no-store` | Keeps nothing on disk, and prints the access credential instead |
| `--json` | Prints the result as JSON (`schema: "downtrace.login/1"`), for a coding agent; `ingestToken` is `null` when none was minted. `accessCredential.storedIn` is the file the credential was kept in, and then its `token` is `null`; when it was not kept, `storedIn` is `null`, `token` is the credential and `notStored` says why |

For a project that is already the person's, an environment with no token yet gets its first one, which replaces
nothing. An environment that has one keeps it: login hands over a credential and **no ingestion token**, and the token
the deployment sends with stays as it is. With `--rotate-token` it asks for that environment's token too, and the
approval page says plainly that it replaces the one there is. The old token stops working when `downtrace login` collects the
new one, not when the person approves: batches sent with it are refused from then on, and the result says it replaced
one. That is how a token is rotated.

It speaks only to the cloud it asked: a link to approve or an address to send to on another origin is refused, and
nothing the cloud says is printed with the control characters a terminal would act on.

The person can deny it, and a cloud can refuse it: a project of that name belongs to another account, the account
holds as many projects as one may, or the cloud's sign-up is full and keeps the person on its waiting list. Each is
said in the cloud's own words, after its address. A cloud whose operator has not opened sign-up says that too, and its
operator creates projects instead.

Exit status of login: 0 approved, 1 not approved (denied, expired, refused, the cloud unreachable or interrupted), 2 a
usage error.

## Read the project from the shell: `downtrace brief` and `downtrace api`

```sh
npx downtrace brief                       # the project login stored for Downtrace's cloud
npx downtrace brief --project nidus-api --json
npx downtrace api /api/p/nidus-api/findings/42/report
```

A coding agent reads its project with these two where the MCP server is not there yet —in Claude Code, a server added
during a session is there only in the next— or not at all, as in Codex, Cursor or a CI job. They read with the
credential login stored, and need no configuration.

`brief` reads the project's brief: what a coding agent reads first, within a fixed size, each item saying where its
detail is. As text it prints the headline, what needs attention with the command that reads each item's detail, and
the read that follows; with `--json`, the cloud's answer as it came, which also has the busiest routes, the routes
whose requests run one operation many times, the telemetry of each environment, what the brief cannot say, and each
item's MCP tool with its arguments.

```
nidus-api: Telemetry arrived in the last 24 hours from 1 of 1 environment(s). 1 open finding(s); 1 error(s) first seen.

Needs attention (2 of 3):
  finding "42": slower, or failing more, than this route usually is
    downtrace api /api/p/nidus-api/findings/42/report
  error "9f3c": an error first seen in this window
    downtrace api /api/p/nidus-api/errors/9f3c

Next: downtrace api '/api/p/nidus-api/changes?since=2026-11-09T16%3A04%3A00Z'
Routes, hotspots, telemetry and what the brief cannot say: downtrace brief --project nidus-api --json
```

`api` reads one path of a project's API, `/api/p/<slug>/…`, such as each item of a brief names, or the same path as a
URL of the cloud, and prints the answer as it came. It only reads: it sends `GET` and takes no method. A path outside a
project's API, another origin, and a segment that is `.` or `..` or hides a separator in an escape are refused before
anything is sent, and a redirect is not followed. Operations —closing a finding, asking for a capture— stay in the MCP
server, which carries their idempotency keys.

The cloud is `--url`, `DOWNTRACE_URL` without it, and Downtrace's cloud without either, as for login. The credential
is `DOWNTRACE_TOKEN` when it is set, unless it holds an ingestion token, `dt_…`, which reads nothing and is not sent;
otherwise the one login stored for that cloud and the project: `--project`, or the only one stored for the cloud, for
`brief`; the project of its path, for `api`. An expired one is not sent, and the command prints the login that renews
it; a file others can read is not used, as above. Neither prints the credential.

| Option | What it is |
|---|---|
| `--project <slug>` | `brief`: the project; the only one login stored for the cloud when not given |
| `--since <instant>` | `brief`: what counts as new, RFC 3339; the last 24 hours when not given |
| `--url <cloud>` | The cloud, as for login |
| `--json` | `brief`: the cloud's answer as it came. Both: a failure as JSON (`schema: "downtrace.read/1"`), its `reason` —`refused`, with the cloud's `httpStatus`, `no-credential`, `expired-credential`, `unreachable`, `timeout`…— and its `message` |

Each request waits 30 seconds at most. Exit status of brief and api: 0 read, 1 the cloud refused (in its own words), 2
nothing could be read (no credential, a path refused, a cloud that cannot be reached or does not answer in 30 s, or an
answer that is not JSON).
