import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// What `downtrace login` writes, by login's own writer: this server's reader is its own (ADR 0078), and this is what
// holds the two to one format.
import { credentialsPath, type StoredCredential, storeCredential } from "../../agent/src/login/store.ts";
import { credentialsPathFrom } from "../src/config.ts";
import { readStoredCredential, type StoredLookup } from "../src/credentials.ts";
import { createServer } from "../src/server.ts";

/**
 * With no `DOWNTRACE_TOKEN`, the server sends, on each call, the access credential `downtrace login` stored for its
 * cloud and the call's project (RF-611). Every test has a home of its own under the system's temporary directory: none
 * reads or writes the user's `~/.config`.
 */

const CLOUD = "https://cloud.test";
const NOW = Date.parse("2026-11-09T12:00:00Z");
const uid = process.getuid?.();
const posix = process.platform !== "win32";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function aFile(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "downtrace-mcp-"));
  homes.push(home);
  return credentialsPath({}, home);
}

function entry(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    url: CLOUD,
    project: "nidus-api",
    environment: "staging",
    environments: ["staging"],
    level: "operate",
    id: "c-1",
    token: "dtr_nidus",
    onBehalfOf: "octocat",
    expiresAt: "2027-02-04T10:00:00Z",
    ...overrides,
  };
}

interface Sent {
  url: string;
  authorization: string | undefined;
}

/** A server with no `DOWNTRACE_TOKEN` (or `token`), reading `file`, and what it sent to a cloud answering `status`. */
function serverOf(file: string, opts: { token?: string; status?: number; now?: number } = {}) {
  const sent: Sent[] = [];
  const read: (string | undefined)[] = [];
  const s = createServer({
    config: { url: CLOUD, token: opts.token ?? "" },
    version: "0.0.0",
    newKey: () => "key-1",
    credentials: (project) => {
      read.push(project);
      return readStoredCredential({ url: CLOUD, project }, { path: file, uid, now: opts.now ?? NOW });
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url: String(url), authorization: headers.authorization });
      return new Response("{}", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await s.handle("tools/call", { name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  return { call, sent, read };
}

const textOf = (out: { content: Array<{ text: string }> }): string => out.content[0]?.text ?? "";

describe("the stored credential of the project asked about", () => {
  it("is the one sent, and no other project's or cloud's", async () => {
    // covers: RF-611
    const file = await aFile();
    await storeCredential(entry(), { path: file, uid });
    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), { path: file, uid });
    await storeCredential(entry({ url: "https://other.example", token: "dtr_elsewhere" }), { path: file, uid });
    const { call, sent } = serverOf(file);

    expect((await call("project_status", { project: "shop-api" })).isError).toBeUndefined();
    expect((await call("project_status", { project: "nidus-api" })).isError).toBeUndefined();
    expect(sent).toEqual([
      { url: `${CLOUD}/api/p/shop-api/status?limit=20&operations=hash`, authorization: "Bearer dtr_shop" },
      { url: `${CLOUD}/api/p/nidus-api/status?limit=20&operations=hash`, authorization: "Bearer dtr_nidus" },
    ]);
  });

  it("gives way to DOWNTRACE_TOKEN, which is sent as before and the file not read", async () => {
    // covers: RF-611
    const file = await aFile();
    await storeCredential(entry(), { path: file, uid });
    const { call, sent, read } = serverOf(file, { token: "dtr_from_the_environment" });
    await call("project_status", { project: "nidus-api" });
    await call("read_credential", {});
    expect(sent.map((s) => s.authorization)).toEqual([
      "Bearer dtr_from_the_environment",
      "Bearer dtr_from_the_environment",
    ]);
    expect(read).toEqual([]);
  });

  it("is not sent once expired, and the call says to run login again", async () => {
    // covers: RF-611
    const file = await aFile();
    await storeCredential(entry({ expiresAt: "2026-11-09T12:00:00Z" }), { path: file, uid });
    const { call, sent } = serverOf(file);
    const out = await call("project_status", { project: "nidus-api" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("expired at 2026-11-09T12:00:00Z");
    expect(textOf(out)).toContain("npx @downtrace/agent login --project nidus-api --env staging --level operate");
    expect(textOf(out)).not.toContain("dtr_");
    expect(sent).toEqual([]);
  });

  it("is read again on each call, so a login made during the session is used without a restart", async () => {
    // covers: RF-611
    const file = await aFile();
    const { call, sent } = serverOf(file, { status: 401 });
    // Nothing stored: the read goes without a credential, as it did with no token, and the refusal says what to run.
    const before = await call("project_status", { project: "nidus-api" });
    expect(before.isError).toBe(true);
    expect(textOf(before)).toContain("the cloud answered 401");
    expect(textOf(before)).toContain("npx @downtrace/agent login --project nidus-api");
    expect(sent[0]?.authorization).toBeUndefined();

    await storeCredential(entry(), { path: file, uid });
    await call("project_status", { project: "nidus-api" });
    // And a login that replaced it, an expired or a revoked one, is the one sent next.
    await storeCredential(entry({ token: "dtr_renewed" }), { path: file, uid });
    await call("project_status", { project: "nidus-api" });
    expect(sent.slice(1).map((s) => s.authorization)).toEqual(["Bearer dtr_nidus", "Bearer dtr_renewed"]);
  });

  it("operates when it is of a project, and says how to get one when there is none", async () => {
    // covers: RF-611
    const file = await aFile();
    const { call, sent } = serverOf(file);
    const refused = await call("resolve_error", { project: "nidus-api", error: "abc", why: "fixed" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("DOWNTRACE_TOKEN");
    expect(textOf(refused)).toContain("npx @downtrace/agent login --project nidus-api --level operate");
    expect(sent).toEqual([]);

    await storeCredential(entry(), { path: file, uid });
    expect((await call("resolve_error", { project: "nidus-api", error: "abc", why: "fixed" })).isError).toBeUndefined();
    expect(sent).toEqual([{ url: `${CLOUD}/api/p/nidus-api/errors/abc/resolve`, authorization: "Bearer dtr_nidus" }]);
  });

  it("for read_credential with no project, is the only one stored for the cloud", async () => {
    // covers: RF-611
    const file = await aFile();
    await storeCredential(entry(), { path: file, uid });
    await storeCredential(entry({ url: "https://other.example", project: "shop-api" }), { path: file, uid });
    const { call, sent } = serverOf(file);
    await call("read_credential", {});
    expect(sent).toEqual([{ url: `${CLOUD}/api/credential`, authorization: "Bearer dtr_nidus" }]);

    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), { path: file, uid });
    const several = await call("read_credential", {});
    expect(several.isError).toBe(true);
    expect(textOf(several)).toContain("nidus-api, shop-api");
    expect(textOf(several)).toContain("`project`");
    expect(sent).toHaveLength(1);

    // Named, it is that project's, and the project is not sent: the credential names its project itself.
    await call("read_credential", { project: "shop-api" });
    expect(sent[1]).toEqual({ url: `${CLOUD}/api/credential`, authorization: "Bearer dtr_shop" });
  });

  it("is not taken from a file it cannot use, and the call says why without what the file holds", async () => {
    // covers: RF-611
    const file = await aFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, '{"schema":"downtrace.credentials/1","credentials":[{"token":"dtr_in_a_broken_file"', {
      mode: 0o600,
    });
    const { call, sent } = serverOf(file);
    const out = await call("project_status", { project: "nidus-api" });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain(file);
    expect(textOf(out)).toContain("not JSON");
    expect(textOf(out)).not.toContain("dtr_");
    expect(sent).toEqual([]);
  });
});

describe("a stored credential that cannot be read", () => {
  it("is said as a result, and nothing is sent", async () => {
    const sent: string[] = [];
    const s = createServer({
      config: { url: CLOUD, token: "" },
      version: "0.0.0",
      credentials: async () => {
        throw new Error("EIO");
      },
      fetchImpl: (async (url: string | URL | Request) => {
        sent.push(String(url));
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    const out = (await s.handle("tools/call", { name: "project_status", arguments: { project: "x" } })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain("could not be read: EIO");
    expect(sent).toEqual([]);
  });

  it("names the projects stored for the cloud when the one asked about is not", async () => {
    // covers: RF-611
    const file = await aFile();
    await storeCredential(entry({ project: "shop-api" }), { path: file, uid });
    const { call } = serverOf(file, { status: 401 });
    const out = await call("project_status", { project: "nidus-api" });
    expect(textOf(out)).toContain("stored no credential for nidus-api at https://cloud.test");
    expect(textOf(out)).toContain("credentials of shop-api");
  });
});

describe("the server's reader of the credentials file", () => {
  const lookup = (file: string, project: string | undefined, now = NOW): Promise<StoredLookup> =>
    readStoredCredential({ url: CLOUD, project }, { path: file, uid, now });

  it("reads what login wrote, by cloud and project", async () => {
    // covers: RF-611
    const file = await aFile();
    expect(await lookup(file, "nidus-api")).toEqual({ kind: "missing", projects: [] });
    await storeCredential(entry({ url: `${CLOUD}/` }), { path: file, uid });
    expect(await lookup(file, "nidus-api")).toMatchObject({ kind: "found", credential: { token: "dtr_nidus" } });
    expect(await lookup(file, undefined)).toMatchObject({ kind: "found" });
    expect(await lookup(file, "shop-api")).toEqual({ kind: "missing", projects: ["nidus-api"] });
    expect(await lookup(file, "nidus-api", Date.parse("2027-02-04T10:00:00Z"))).toMatchObject({ kind: "expired" });
  });

  it("refuses a file of another version, and one that is not the file", async () => {
    const file = await aFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ schema: "downtrace.credentials/2", credentials: [] }), { mode: 0o600 });
    expect(await lookup(file, "x")).toMatchObject({
      kind: "unusable",
      reason: expect.stringContaining("downtrace.credentials/2"),
    });
    await writeFile(file, "[]", { mode: 0o600 });
    expect(await lookup(file, "x")).toMatchObject({ kind: "unusable" });
  });

  it.skipIf(!posix)(
    "refuses a file others can read or write, a symbolic link, and a file of another user",
    async () => {
      // covers: RF-611
      const file = await aFile();
      await storeCredential(entry(), { path: file, uid });
      await chmod(file, 0o644);
      const open = await lookup(file, "nidus-api");
      expect(open).toMatchObject({ kind: "unusable", reason: expect.stringContaining(`chmod 600 ${file}`) });
      expect(JSON.stringify(open)).not.toContain("dtr_");
      await chmod(file, 0o600);

      const linked = await aFile();
      await mkdir(dirname(linked), { recursive: true, mode: 0o700 });
      await symlink(file, linked);
      expect(await lookup(linked, "nidus-api")).toMatchObject({
        kind: "unusable",
        reason: expect.stringContaining("symbolic link"),
      });

      if (uid === undefined) return;
      const other = await readStoredCredential(
        { url: CLOUD, project: "nidus-api" },
        { path: file, uid: uid + 1, now: NOW },
      );
      expect(other).toMatchObject({ kind: "unusable", reason: expect.stringContaining("another user") });
    },
  );
});

describe("where the server looks for the credentials file", () => {
  it("is where login writes it: $XDG_CONFIG_HOME/downtrace, or ~/.config/downtrace", () => {
    // covers: RF-611
    for (const env of [{}, { XDG_CONFIG_HOME: "/xdg" }, { XDG_CONFIG_HOME: "relative" }, { XDG_CONFIG_HOME: " " }]) {
      const get = (name: string): string | undefined => (env as Record<string, string>)[name];
      expect(credentialsPathFrom(get, "/home/u"), JSON.stringify(env)).toBe(credentialsPath(env, "/home/u"));
    }
  });
});
