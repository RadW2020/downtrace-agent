import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DOWNTRACE_CLOUD, LOGIN_SCHEMA, LOGIN_USAGE, parseLoginArgs, runLogin } from "../src/login/command.ts";
import { CREDENTIALS_SCHEMA, credentialsPath } from "../src/login/store.ts";
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
/** The home directory each login is given: one of its own under the system's temporary one, never the user's. */
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function aHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "downtrace-login-"));
  homes.push(home);
  return home;
}

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

/** Runs login with the clock moved by each wait, in a home of its own unless given one, and what it printed. */
async function login(argv: string[], env: NodeJS.ProcessEnv = {}, signal?: AbortSignal, home?: string) {
  let clock = 0;
  const waits: number[] = [];
  let stdout = "";
  let stderr = "";
  const at = home ?? (await aHome());
  const code = await runLogin({
    argv,
    env,
    home: at,
    uid: process.getuid?.(),
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
  return { code, stdout, stderr, waits, home: at };
}

describe("downtrace login", () => {
  it("asks for the project, waits for the approval and prints what it received, once", async () => {
    const c = await cloud(aCode, [pending, { status: 400, body: { error: "slow_down" } }, pending, approved]);
    // What it prints when asked to keep nothing, as it did before it kept the credential (RF-611).
    const run = await login(["--project", "nidus-api", "--env", "staging", "--level", "operate", "--no-store"], {
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
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json", "--no-store"]);
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
        storedIn: null,
        notStored: "--no-store asked not to keep it",
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

/** What a file's permissions are, without its type. */
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("downtrace login keeps the credential it collected", () => {
  it("in a file only its user reads, and prints it no second time", async () => {
    // covers: RF-611
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--env", "staging", "--url", c.url, "--json"]);
    expect(run.code).toBe(0);
    const file = credentialsPath({}, run.home);
    const result = JSON.parse(run.stdout) as { accessCredential: Record<string, unknown>; ingestToken: unknown };
    expect(result.accessCredential).toEqual({
      id: "c-1",
      token: null,
      level: "operate",
      onBehalfOf: "octocat",
      environments: ["staging"],
      expiresAt: "2027-02-04T10:00:00Z",
      storedIn: file,
      notStored: null,
    });
    // The ingestion token only sends, and goes where the backend reads it: login still prints it, once.
    expect(result.ingestToken).toBe("dt_ingest");
    expect(run.stdout).not.toContain("dtr_access");
    expect(run.stderr).not.toContain("dtr_access");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schema: CREDENTIALS_SCHEMA,
      credentials: [
        {
          url: c.url,
          project: "nidus-api",
          environment: "staging",
          environments: ["staging"],
          level: "operate",
          id: "c-1",
          token: "dtr_access",
          onBehalfOf: "octocat",
          expiresAt: "2027-02-04T10:00:00Z",
        },
      ],
    });
    if (process.platform !== "win32") {
      expect(await modeOf(file)).toBe(0o600);
      expect(await modeOf(dirname(file))).toBe(0o700);
    }
  });

  it("says where in its text, with the MCP server's configuration and no credential in it", async () => {
    // covers: RF-611
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--env", "staging", "--url", c.url]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`It is stored in ${credentialsPath({}, run.home)}, readable by you alone`);
    expect(run.stdout).toContain(`"DOWNTRACE_URL": "${c.url}"`);
    expect(run.stdout).not.toContain('"DOWNTRACE_TOKEN"');
    expect(run.stdout).not.toContain("dtr_access");
    expect(run.stdout).toContain(`DOWNTRACE_TOKEN=dt_ingest DOWNTRACE_URL=${c.url}`);
    expect(run.stdout).toContain("The ingestion token is shown only once.");
  });

  it("under $XDG_CONFIG_HOME when it names a directory", async () => {
    // covers: RF-611
    const xdg = await aHome();
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json"], { XDG_CONFIG_HOME: xdg });
    expect(JSON.parse(run.stdout).accessCredential.storedIn).toBe(join(xdg, "downtrace", "credentials.json"));
    expect(await readdir(run.home)).toEqual([]);
  });

  it("writes nothing with --no-store, and prints the credential as it did", async () => {
    // covers: RF-611
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--url", c.url, "--no-store"]);
    expect(run.code).toBe(0);
    expect(await readdir(run.home)).toEqual([]);
    expect(run.stdout).toContain('"DOWNTRACE_TOKEN": "dtr_access"');
    expect(run.stdout).toContain("Both are shown only once.");
  });

  it("replaces the entry of the same cloud and project, and keeps another project's", async () => {
    // covers: RF-611
    const home = await aHome();
    const withCredential = (project: string, token: string): Answer => ({
      status: 200,
      body: {
        ...(approved.body as object),
        project: { slug: project, name: project },
        access_credential: { ...(approved.body as { access_credential: object }).access_credential, token },
      },
    });
    // One cloud, answering three logins in turn.
    const c = await cloud(aCode, [
      withCredential("nidus-api", "dtr_first"),
      withCredential("shop-api", "dtr_shop"),
      withCredential("nidus-api", "dtr_second"),
    ]);
    for (const project of ["nidus-api", "shop-api", "nidus-api"]) {
      const run = await login(["--project", project, "--url", c.url], {}, undefined, home);
      expect(run.code).toBe(0);
    }
    const stored = JSON.parse(await readFile(credentialsPath({}, home), "utf8")) as {
      credentials: { url: string; project: string; token: string }[];
    };
    expect(stored.credentials.map((e) => [e.url, e.project, e.token])).toEqual([
      [c.url, "shop-api", "dtr_shop"],
      [c.url, "nidus-api", "dtr_second"],
    ]);
  });

  it("says why when it cannot keep it, prints it instead, and still exits 0", async () => {
    // covers: RF-611
    // Approved and collected: the code cannot be collected twice, so the credential is printed rather than lost.
    const home = await aHome();
    await writeFile(join(home, ".config"), "a file where the directory would be");
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json"], {}, undefined, home);
    expect(run.code).toBe(0);
    const credential = JSON.parse(run.stdout).accessCredential;
    expect(credential.token).toBe("dtr_access");
    expect(credential.storedIn).toBeNull();
    expect(credential.notStored).toContain(join(home, ".config"));
    expect(credential.notStored).not.toContain("dtr_");

    const text = await cloud(aCode, [approved]);
    const said = await login(["--project", "nidus-api", "--url", text.url], {}, undefined, home);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("It could not be stored:");
    expect(said.stdout).toContain('"DOWNTRACE_TOKEN": "dtr_access"');
  });

  it("leaves a file it cannot read as it is", async () => {
    // covers: RF-611
    const home = await aHome();
    const file = credentialsPath({}, home);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, "not json", { mode: 0o600 });
    const c = await cloud(aCode, [approved]);
    const run = await login(["--project", "nidus-api", "--url", c.url, "--json"], {}, undefined, home);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).accessCredential).toMatchObject({ token: "dtr_access", storedIn: null });
    expect(JSON.parse(run.stdout).accessCredential.notStored).toContain("not JSON");
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("stores nothing when the login is not approved", async () => {
    const c = await cloud(aCode, [{ status: 400, body: { error: "access_denied" } }]);
    const run = await login(["--project", "nidus-api", "--url", c.url]);
    expect(run.code).toBe(1);
    expect(await readdir(run.home)).toEqual([]);
  });
});

/**
 * Runs login against Downtrace's cloud, whose address is not this machine's: `fetch` is stood in, answering each path
 * with what `answers` scripts, so nothing leaves the machine.
 */
async function loginToDowntraceCloud(argv: string[], answers: Record<string, Answer | Error>) {
  const asked: string[] = [];
  let clock = 0;
  let stdout = "";
  let stderr = "";
  const code = await runLogin({
    argv,
    env: {},
    home: await aHome(),
    uid: process.getuid?.(),
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    signal: undefined,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async (input) => {
      const url = String(input);
      asked.push(url);
      const answer = answers[new URL(url).pathname];
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`nothing scripted for ${url}`);
      const body = JSON.stringify(answer.body).replaceAll("{base}", DOWNTRACE_CLOUD);
      return new Response(body, { status: answer.status, headers: { "content-type": "application/json" } });
    },
  });
  return { code, stdout, stderr, asked };
}

describe("downtrace login with no cloud named", () => {
  it("asks Downtrace's cloud, and hands over what it approved for that address", async () => {
    // covers: RF-519
    const run = await loginToDowntraceCloud(["--project", "nidus-api", "--env", "staging"], {
      "/login/device/code": aCode,
      "/login/device/token": approved,
    });
    expect(run.code).toBe(0);
    expect(run.asked).toEqual([`${DOWNTRACE_CLOUD}/login/device/code`, `${DOWNTRACE_CLOUD}/login/device/token`]);
    expect(run.stderr).toContain(`open ${DOWNTRACE_CLOUD}/device?code=BCDF-GHJK`);
    expect(run.stdout).toContain(`DOWNTRACE_TOKEN=dt_ingest DOWNTRACE_URL=${DOWNTRACE_CLOUD}`);
  });

  it("names the cloud that refused, which the person did not name", async () => {
    // covers: RF-519
    // Downtrace's cloud before its operator opens sign-up: the request reaches it, and what it says is said.
    const closed = await loginToDowntraceCloud(["--project", "nidus-api"], {
      "/login/device/code": {
        status: 503,
        body: {
          error: "not_configured",
          error_description: "sign-up is not configured on this cloud: its operator creates projects",
        },
      },
    });
    expect(closed.code).toBe(1);
    expect(closed.asked).toEqual([`${DOWNTRACE_CLOUD}/login/device/code`]);
    expect(closed.stdout).toBe("");
    expect(closed.stderr).toBe(
      `downtrace login: the cloud at ${DOWNTRACE_CLOUD} answered: sign-up is not configured on this cloud: its operator creates projects\n`,
    );

    const json = await loginToDowntraceCloud(["--project", "nidus-api", "--json"], {
      "/login/device/code": { status: 502, body: "Bad Gateway" },
    });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      schema: LOGIN_SCHEMA,
      status: "failed",
      reason: "refused",
      message: `the cloud at ${DOWNTRACE_CLOUD} answered 502 to the request for a code`,
    });

    const denied = await loginToDowntraceCloud(["--project", "nidus-api"], {
      "/login/device/code": aCode,
      "/login/device/token": {
        status: 400,
        body: { error: "access_denied", error_description: "the person denied it" },
      },
    });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain(
      `downtrace login: the cloud at ${DOWNTRACE_CLOUD} answered: the person denied it\n`,
    );

    const unreachable = await loginToDowntraceCloud(["--project", "nidus-api"], {
      "/login/device/code": new Error("getaddrinfo ENOTFOUND"),
    });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain(`the cloud at ${DOWNTRACE_CLOUD} did not answer: getaddrinfo ENOTFOUND`);
  });
});

describe("the address of Downtrace's cloud", () => {
  it("is written in one place of packages/, and everything else takes it from there", async () => {
    // covers: RF-519
    // A later domain is a second name of the same cloud: what writes the address by hand is what would be left behind.
    // The public text of packages/ is what git tracks there and what it would add; nothing it ignores is published.
    const packages = fileURLToPath(new URL("../../", import.meta.url));
    const { stdout } = await promisify(execFile)(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
      { cwd: packages, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const files = stdout.split("\0").filter((file) => file !== "");
    expect(files).toContain("agent/src/login/command.ts");
    const host = new URL(DOWNTRACE_CLOUD).host;
    const writing: string[] = [];
    for (const file of files) {
      const text = await readFile(join(packages, file), "utf8").catch((err: NodeJS.ErrnoException) => {
        // Deleted in the working tree and not yet in the index: it is no longer published.
        if (err.code === "ENOENT") return "";
        throw err;
      });
      if (text.toLowerCase().includes(host)) writing.push(file);
    }
    expect(writing).toEqual(["agent/src/login/command.ts"]);
  });
});

describe("the command line of downtrace login", () => {
  it.each([
    [[], {}, "--project is required"],
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
        store: true,
      },
    });
    expect(parseLoginArgs(["--project=x", "--no-store"], {})).toMatchObject({ kind: "login", args: { store: false } });
    for (const local of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(parseLoginArgs(["--project=x", `--url=${local}`], {}).kind, local).toBe("login");
    }
  });

  it("asks Downtrace's cloud when neither --url nor DOWNTRACE_URL names one, and the one named otherwise", () => {
    // covers: RF-519
    const cloudOf = (argv: string[], env: NodeJS.ProcessEnv): string => {
      const parsed = parseLoginArgs(argv, env);
      return parsed.kind === "login" ? parsed.args.url : parsed.kind;
    };
    expect(cloudOf(["--project", "x"], {})).toBe(DOWNTRACE_CLOUD);
    expect(cloudOf(["--project", "x"], { DOWNTRACE_URL: " " })).toBe(DOWNTRACE_CLOUD);
    expect(cloudOf(["--project", "x"], { DOWNTRACE_URL: "https://mine.example/" })).toBe("https://mine.example");
    expect(
      cloudOf(["--project", "x", "--url", "https://named.example"], { DOWNTRACE_URL: "https://mine.example" }),
    ).toBe("https://named.example");
    // An origin login can send a sign-up to, with nothing after it to strip.
    expect(new URL(DOWNTRACE_CLOUD).protocol).toBe("https:");
    expect(new URL(DOWNTRACE_CLOUD).origin).toBe(DOWNTRACE_CLOUD);
    // The usage says which cloud that is: the guide and the README do not write it.
    expect(LOGIN_USAGE).toContain(DOWNTRACE_CLOUD);
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

  it("says how to get a token with downtrace login, with no address to fill in", async () => {
    // covers: RF-519
    const page = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const readme = await page("README.md");
    const start = readme.indexOf("\n## Install\n");
    expect(start).toBeGreaterThanOrEqual(0);
    const install = readme.slice(start, readme.indexOf("\n## ", start + 1));
    for (const [where, text] of [
      ["the README's install section", install],
      ["guide/login.md", await page("guide/login.md")],
    ] as const) {
      const commands = fenced(text).filter((line) => /\blogin --project\b/.test(line));
      expect(commands, where).not.toEqual([]);
      for (const command of commands) {
        // As written, it reaches Downtrace's cloud: there is nothing in it to replace.
        const argv = (command.split("#")[0] ?? "").trim().split(/\s+/);
        const parsed = parseLoginArgs(argv.slice(argv.indexOf("login") + 1), {});
        expect(parsed, `${where}: ${command}`).toMatchObject({ kind: "login", args: { url: DOWNTRACE_CLOUD } });
      }
      expect(text, where).toContain("Downtrace's cloud");
    }
  });
});

/** The lines of a page's code blocks. */
function fenced(markdown: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inside = !inside;
    else if (inside) lines.push(line);
  }
  return lines;
}
