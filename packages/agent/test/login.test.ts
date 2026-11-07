import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_SCHEMA, LOGIN_USAGE, parseLoginArgs, runLogin } from "../src/login/command.ts";
import { readDocumentation } from "./support/documentation.ts";

/**
 * `downtrace login` against a cloud that speaks the device flow (RFC 8628): a server on this machine that answers
 * what each test scripts, and a clock that the waits move, so nothing waits for real.
 */

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

interface FakeCloud {
  url: string;
  /** Every request, its path and its JSON body. */
  seen: { path: string; body: unknown }[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** A cloud answering the code request with `code` and each poll with the next of `polls`. */
async function cloud(code: Answer, polls: Answer[]): Promise<FakeCloud> {
  const seen: { path: string; body: unknown }[] = [];
  const queue = [...polls];
  let base = "";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", body: raw === "" ? undefined : JSON.parse(raw) });
      const answer = req.url === "/login/device/code" ? code : (queue.shift() ?? pending);
      if (answer.status === 0) {
        req.socket.destroy();
        return;
      }
      res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      // `{base}` in an answer is this cloud's own address, which it only knows once it listens.
      res.end(JSON.stringify(answer.body).replaceAll("{base}", base));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return { url: base, seen };
}

const aCode: Answer = {
  status: 200,
  body: {
    device_code: "the-device-code",
    user_code: "BCDF-GHJK",
    verification_uri: "{base}/device",
    verification_uri_complete: "{base}/device?code=BCDF-GHJK",
    expires_in: 900,
    interval: 5,
  },
};
const pending: Answer = { status: 400, body: { error: "authorization_pending" } };
const approved: Answer = {
  status: 200,
  body: {
    url: "{base}",
    project: { slug: "nidus-api", name: "Nidus API" },
    environment: "staging",
    ingest_token: "dt_ingest",
    replaced: false,
    access_credential: {
      id: "c-1",
      token: "dtr_access",
      level: "operate",
      on_behalf_of: "octocat",
      environments: ["staging"],
      expires_at: "2027-02-04T10:00:00Z",
    },
  },
};

/** Runs login with the clock moved by each wait, and what it printed. */
async function login(argv: string[], env: NodeJS.ProcessEnv = {}, signal?: AbortSignal) {
  let clock = 0;
  const waits: number[] = [];
  let stdout = "";
  let stderr = "";
  const code = await runLogin({
    argv,
    env,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    signal,
    now: () => clock,
    sleep: async (ms, s) => {
      if (s?.aborted === true) throw new Error("aborted");
      waits.push(ms);
      clock += ms;
    },
  });
  return { code, stdout, stderr, waits };
}

describe("downtrace login", () => {
  it("asks for the project, waits for the approval and prints what it received, once", async () => {
    const c = await cloud(aCode, [pending, { status: 400, body: { error: "slow_down" } }, pending, approved]);
    const run = await login(["--project", "nidus-api", "--env", "staging", "--level", "operate"], {
      DOWNTRACE_URL: `${c.url}/`,
    });

    expect(run.code).toBe(0);
    expect(c.seen[0]).toEqual({
      path: "/login/device/code",
      body: { project: "nidus-api", environment: "staging", level: "operate" },
    });
    expect(c.seen.slice(1).every((r) => r.path === "/login/device/token")).toBe(true);
    expect(c.seen[1]?.body).toEqual({ device_code: "the-device-code" });
    // The person is told where to go and which code to check, on stderr: stdout is the result.
    expect(run.stderr).toContain(`${c.url}/device?code=BCDF-GHJK`);
    expect(run.stderr).toContain("BCDF-GHJK");
    // Five seconds, then five more after the cloud said to slow down.
    expect(run.waits).toEqual([5000, 5000, 10_000, 10_000]);
    expect(run.stdout).toContain(`DOWNTRACE_TOKEN=dt_ingest DOWNTRACE_URL=${c.url}`);
    expect(run.stdout).toContain("It only sends data, and reads nothing");
    expect(run.stdout).toContain("level operate, on behalf of octocat");
    expect(run.stdout).toContain('"DOWNTRACE_TOKEN": "dtr_access"');
    expect(run.stdout).toContain("for nidus-api, restricted to staging.");
    expect(run.stdout).not.toContain("nothing else");
    expect(run.stdout).toContain("It expires at 2027-02-04T10:00:00Z");
    expect(run.stdout).not.toContain("replaced");
  });

  it("prints the result as JSON for a coding agent, and says when a token was replaced", async () => {
    const c = await cloud(aCode, [{ status: 200, body: { ...(approved.body as object), replaced: true } }]);
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      schema: LOGIN_SCHEMA,
      status: "approved",
      url: c.url,
      project: { slug: "nidus-api", name: "Nidus API" },
      environment: "staging",
      ingestToken: "dt_ingest",
      replaced: true,
      accessCredential: {
        id: "c-1",
        token: "dtr_access",
        level: "operate",
        onBehalfOf: "octocat",
        environments: ["staging"],
        expiresAt: "2027-02-04T10:00:00Z",
      },
    });
    // Production and read when nothing else is asked for.
    expect(c.seen[0]?.body).toEqual({ project: "nidus-api", environment: "production", level: "read" });
  });

  it.each([
    [
      "denied",
      {
        error: "access_denied",
        reason: "full",
        error_description: "sign-up is full: the person is on its waiting list",
      },
      "waiting list",
    ],
    ["expired", { error: "expired_token", error_description: "the code expired before it was approved" }, "expired"],
    [
      "already collected",
      { error: "invalid_grant", error_description: "this code was already collected" },
      "already collected",
    ],
  ])("says why when the request is %s, and exits 1", async (_, body, says) => {
    const c = await cloud(aCode, [pending, { status: 400, body }]);
    const run = await login(["--project", "nidus-api", "--url", c.url]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(says);
    expect(run.stdout).toBe("");

    const again = await cloud(aCode, [{ status: 400, body }]);
    const json = await login(["--project", "nidus-api", "--url", again.url, "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ schema: LOGIN_SCHEMA, status: "failed", reason: body.error });
  });

  it("says the cloud has no sign-up when it is not configured", async () => {
    const c = await cloud(
      { status: 503, body: { error: "not_configured", error_description: "sign-up is not configured on this cloud" } },
      [],
    );
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "failed", reason: "not_configured" });
    expect(c.seen).toHaveLength(1);
  });

  it("keeps asking through a dropped connection, a 5xx and a 429, until the code expires", async () => {
    const c = await cloud({ ...aCode, body: { ...(aCode.body as object), expires_in: 60 } }, [
      { status: 0, body: null },
      { status: 502, body: {} },
      { status: 429, body: {}, headers: { "retry-after": "20" } },
      approved,
    ]);
    const run = await login(["--project", "nidus-api", "--url", c.url]);
    expect(run.code).toBe(0);
    expect(run.waits).toEqual([5000, 5000, 5000, 20_000]);

    const never = await cloud({ ...aCode, body: { ...(aCode.body as object), expires_in: 12 } }, []);
    const expired = await login(["--project", "nidus-api", "--url", never.url]);
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain("expired before it was approved");
  });

  it("says when the cloud does not answer at all", async () => {
    const run = await login(["--project", "nidus-api", "--url", "http://127.0.0.1:1"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("did not answer");
  });

  it("stops when it is interrupted", async () => {
    const c = await cloud(aCode, []);
    const abort = new AbortController();
    abort.abort();
    const run = await login(["--project", "nidus-api", "--url", c.url], {}, abort.signal);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("interrupted");
  });

  it("refuses an answer that is not the shape it expects", async () => {
    const c = await cloud({ status: 200, body: { user_code: "BCDF-GHJK" } }, []);
    const run = await login(["--project", "nidus-api", "--url", c.url]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not one");
  });
});

describe("downtrace login and a cloud it does not trust blindly", () => {
  it("connects an existing project with no token unless asked to rotate it, and asks when told to", async () => {
    const credentialOnly = { ...(approved.body as object), replaced: false } as Record<string, unknown>;
    delete credentialOnly.ingest_token;
    const c = await cloud(aCode, [{ status: 200, body: credentialOnly }]);
    const run = await login(["--project", "nidus-api", "--env", "staging", "--url", c.url]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("No ingestion token: nidus-api existed");
    expect(run.stdout).toContain("--rotate-token");
    expect(run.stdout).not.toContain("DOWNTRACE_TOKEN=dt_");
    expect(c.seen[0]?.body).not.toHaveProperty("rotate_token");

    const json = await cloud(aCode, [{ status: 200, body: credentialOnly }]);
    const asJson = await login(["--project", "nidus-api", "--url", json.url, "--json"]);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ status: "approved", ingestToken: null });

    const rotating = await cloud(aCode, [approved]);
    await login(["--project", "nidus-api", "--url", rotating.url, "--rotate-token"]);
    expect(rotating.seen[0]?.body).toEqual({
      project: "nidus-api",
      environment: "production",
      level: "read",
      rotate_token: true,
    });
  });

  it("refuses a page or an address to send to on another origin than the cloud it asked", async () => {
    const elsewhere = await cloud(
      { ...aCode, body: { ...(aCode.body as object), verification_uri_complete: "https://phish.example/device" } },
      [],
    );
    const sent = await login(["--project", "nidus-api", "--url", elsewhere.url]);
    expect(sent.code).toBe(1);
    expect(sent.stderr).toContain("another address");
    expect(sent.stderr).not.toContain("phish.example/device");

    const redirected = await cloud(aCode, [
      { status: 200, body: { ...(approved.body as object), url: "https://collector.example" } },
    ]);
    const run = await login(["--project", "nidus-api", "--url", redirected.url]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("another address");
  });

  it("prints no control character the cloud sends", async () => {
    const c = await cloud(aCode, [
      {
        status: 400,
        body: { error: "access_denied", error_description: "denied\u001b[2J\u001b]8;;https://x\u0007 \u202eesrever" },
      },
    ]);
    const run = await login(["--project", "nidus-api", "--url", c.url]);
    expect(run.code).toBe(1);
    // Every line of it, without the line breaks this command writes itself.
    for (const line of run.stderr.split("\n")) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what must not be there.
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    }
    expect(run.stderr).toContain("denied[2J]8;;https://x esrever");
  });
});

describe("the command line of downtrace login", () => {
  it.each([
    [[], {}, "--project is required"],
    [["--project", "x"], {}, "--url or DOWNTRACE_URL"],
    [["--project", "x", "--url", "ftp://cloud"], {}, "must be https://"],
    [["--project", "x", "--url", "http://cloud.example"], {}, "http:// only for localhost"],
    [["--project", "x"], { DOWNTRACE_URL: "http://10.0.0.5:8080" }, "http:// only for localhost"],
    [["--project", "x", "--url", "https://c", "--level", "admin"], {}, "read or operate"],
    [["--project", "x", "--url", "https://c", "--bogus"], {}, "unknown option --bogus"],
    [["--project"], {}, "--project needs a value"],
    [["stray"], {}, 'unexpected "stray"'],
  ])("refuses %j", async (argv, env, says) => {
    const run = await login(argv as string[], env);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(says);
    expect(run.stderr).toContain("Usage: downtrace login");
  });

  it("reads --flag=value and the URL without its trailing slashes", () => {
    expect(parseLoginArgs(["--project=x", "--env=staging", "--url=https://c//", "--rotate-token"], {})).toEqual({
      kind: "login",
      args: {
        project: "x",
        environment: "staging",
        level: "read",
        name: undefined,
        rotateToken: true,
        url: "https://c",
        json: false,
      },
    });
    for (const local of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(parseLoginArgs(["--project=x", `--url=${local}`], {}).kind, local).toBe("login");
    }
  });

  it("prints its usage", async () => {
    const run = await login(["--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(LOGIN_USAGE);
  });
});

describe("the documentation of downtrace login", () => {
  it("documents every option of the command, and its exit statuses", async () => {
    const docs = (await readDocumentation()).replaceAll("`", "");
    for (const option of LOGIN_USAGE.match(/--[a-z]+/g) ?? []) {
      if (option === "--help") continue;
      expect(docs.includes(option), option).toBe(true);
    }
    expect(docs).toContain("Exit status of login: 0 approved, 1 not approved");
    expect(docs).toContain(`schema: "${LOGIN_SCHEMA}"`);
  });
});
