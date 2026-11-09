import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_SCHEMA,
  CredentialStoreError,
  credentialsPath,
  readStoredCredential,
  type StoredCredential,
  storeCredential,
} from "../src/login/store.ts";

/**
 * Where `downtrace login` keeps the access credential it collected, and how a command of this package finds it again
 * (RF-611). Every test has a directory of its own under the system's temporary one: none touches the user's
 * `~/.config`.
 */

const posix = process.platform !== "win32";
const uid = process.getuid?.();
/** Root reads and writes whatever the modes say, so a directory it cannot write is not one it can make. */
const root = uid === 0;

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    // A test may have taken the write permission away; give it back so the directory can go.
    await chmod(join(home, ".config", "downtrace"), 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

async function aHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "downtrace-store-"));
  homes.push(home);
  return home;
}

/** The file of a home, and what the store is handed to reach it. */
async function aStore(): Promise<{ path: string; access: { path: string; uid: number | undefined } }> {
  const path = credentialsPath({}, await aHome());
  return { path, access: { path, uid } };
}

const NOW = Date.parse("2026-11-09T12:00:00Z");

function entry(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    url: "https://cloud.example",
    project: "nidus-api",
    environment: "staging",
    environments: ["staging"],
    level: "operate",
    id: "c-1",
    token: "dtr_first",
    onBehalfOf: "octocat",
    expiresAt: "2027-02-04T10:00:00Z",
    ...overrides,
  };
}

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("where login keeps the credentials", () => {
  it("is credentials.json under $XDG_CONFIG_HOME/downtrace, or ~/.config/downtrace without it", () => {
    // covers: RF-611
    expect(credentialsPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "downtrace", "credentials.json"));
    expect(credentialsPath({}, "/home/u")).toBe(join("/home/u", ".config", "downtrace", "credentials.json"));
    expect(credentialsPath({ XDG_CONFIG_HOME: " " }, "/home/u")).toBe(
      join("/home/u", ".config", "downtrace", "credentials.json"),
    );
    // The XDG specification: a relative path is not one, and is ignored.
    expect(credentialsPath({ XDG_CONFIG_HOME: "relative" }, "/home/u")).toBe(
      join("/home/u", ".config", "downtrace", "credentials.json"),
    );
  });
});

describe("storing a credential", () => {
  it.skipIf(!posix)("writes a file only its user reads, in a directory only its user opens", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    await storeCredential(entry(), access);
    expect(await mode(path)).toBe(0o600);
    expect(await mode(dirname(path))).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schema: CREDENTIALS_SCHEMA, credentials: [entry()] });
    // Nothing is left beside it: the temporary file it was written as became it.
    expect(await readdir(dirname(path))).toEqual(["credentials.json"]);
  });

  it("keeps one entry per cloud and project: the new one replaces the earlier, and the others stay", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    await storeCredential(entry(), access);
    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), access);
    await storeCredential(entry({ url: "https://other.example", token: "dtr_other" }), access);
    // The same cloud, written with a trailing slash, and the same project: the earlier entry goes.
    await storeCredential(
      entry({ url: "https://cloud.example/", token: "dtr_second", environment: "production" }),
      access,
    );
    const file = JSON.parse(await readFile(path, "utf8")) as { credentials: StoredCredential[] };
    expect(file.credentials.map((c) => [c.url, c.project, c.token])).toEqual([
      ["https://cloud.example", "shop-api", "dtr_shop"],
      ["https://other.example", "nidus-api", "dtr_other"],
      ["https://cloud.example/", "nidus-api", "dtr_second"],
    ]);
  });

  it.skipIf(!posix)("closes a directory others could open", async () => {
    const { path, access } = await aStore();
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await chmod(dirname(path), 0o755);
    await storeCredential(entry(), access);
    expect(await mode(dirname(path))).toBe(0o700);
  });

  it.skipIf(!posix)("rewrites a file others could read only for its user, keeping its entries", async () => {
    const { path, access } = await aStore();
    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), access);
    await chmod(path, 0o644);
    await storeCredential(entry(), access);
    expect(await mode(path)).toBe(0o600);
    const file = JSON.parse(await readFile(path, "utf8")) as { credentials: StoredCredential[] };
    expect(file.credentials.map((c) => c.project)).toEqual(["shop-api", "nidus-api"]);
  });

  it.skipIf(!posix || root)("says why it cannot write, without the credential, and leaves nothing behind", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o500);
    const failure = await storeCredential(entry(), access).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CredentialStoreError);
    expect(String((failure as Error).message)).toContain(dirname(path));
    expect(String((failure as Error).message)).not.toContain("dtr_first");
    await chmod(dirname(path), 0o700);
    expect(await readdir(dirname(path))).toEqual([]);
  });

  it("refuses a home where a directory cannot be made", async () => {
    const home = await aHome();
    await writeFile(join(home, ".config"), "a file where the directory would be");
    const path = credentialsPath({}, home);
    await expect(storeCredential(entry(), { path, uid })).rejects.toBeInstanceOf(CredentialStoreError);
  });

  it("leaves a file it cannot read as it is, and says so without what it holds", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corrupt = '{"schema":"downtrace.credentials/1","credentials":[{"token":"dtr_kept_by_hand"';
    await writeFile(path, corrupt, { mode: 0o600 });
    const failure = await storeCredential(entry(), access).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(failure).toBeInstanceOf(CredentialStoreError);
    expect(failure?.message).toContain("not JSON");
    expect(failure?.message).not.toContain("dtr_");
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it.skipIf(!posix)("follows no symbolic link: not the file's, not the directory's", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    const elsewhere = join(await aHome(), "target.json");
    await writeFile(elsewhere, "{}");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, path);
    await expect(storeCredential(entry(), access)).rejects.toThrow(/symbolic link/);
    expect(await readFile(elsewhere, "utf8")).toBe("{}");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);

    const home = await aHome();
    const outside = await aHome();
    await mkdir(join(home, ".config"));
    await symlink(outside, join(home, ".config", "downtrace"));
    await expect(storeCredential(entry(), { path: credentialsPath({}, home), uid })).rejects.toThrow(/symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(uid === undefined)("refuses a file of another user", async () => {
    const { path, access } = await aStore();
    await storeCredential(entry(), access);
    const other = { path, uid: (uid ?? 0) + 1 };
    await expect(storeCredential(entry({ token: "dtr_second" }), other)).rejects.toThrow(/another user/);
  });
});

describe("reading a stored credential", () => {
  it("finds the one of a cloud and a project, and no other", async () => {
    // covers: RF-611
    const { access } = await aStore();
    await storeCredential(entry(), access);
    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), access);
    await storeCredential(entry({ url: "https://other.example", token: "dtr_other" }), access);
    const read = (url: string, project: string | undefined) =>
      readStoredCredential({ url, project }, { ...access, now: NOW });

    expect(await read("https://cloud.example", "nidus-api")).toEqual({ kind: "found", credential: entry() });
    expect(await read("https://cloud.example/", "shop-api")).toMatchObject({
      kind: "found",
      credential: { token: "dtr_shop" },
    });
    expect(await read("https://other.example", "nidus-api")).toMatchObject({ credential: { token: "dtr_other" } });
    expect(await read("https://cloud.example", "billing")).toEqual({
      kind: "missing",
      projects: ["nidus-api", "shop-api"],
    });
    expect(await read("https://third.example", "nidus-api")).toEqual({ kind: "missing", projects: [] });
  });

  it("with no project, takes the only one stored for the cloud, and names them when there are more", async () => {
    // covers: RF-611
    const { access } = await aStore();
    await storeCredential(entry(), access);
    await storeCredential(entry({ url: "https://other.example", project: "shop-api" }), access);
    const read = (url: string) => readStoredCredential({ url, project: undefined }, { ...access, now: NOW });
    expect(await read("https://cloud.example")).toEqual({ kind: "found", credential: entry() });

    await storeCredential(entry({ project: "shop-api", token: "dtr_shop" }), access);
    expect(await read("https://cloud.example")).toEqual({ kind: "ambiguous", projects: ["nidus-api", "shop-api"] });
  });

  it("says when there is no file at all", async () => {
    const { access } = await aStore();
    expect(await readStoredCredential({ url: "https://cloud.example", project: "x" }, { ...access, now: NOW })).toEqual(
      { kind: "missing", projects: [] },
    );
  });

  it("says an entry expired instead of handing it over as one that opens anything", async () => {
    // covers: RF-611
    const { access } = await aStore();
    await storeCredential(entry({ expiresAt: "2026-11-09T12:00:00Z" }), access);
    await storeCredential(entry({ project: "forever", expiresAt: "" }), access);
    const read = (project: string, now: number) =>
      readStoredCredential({ url: "https://cloud.example", project }, { ...access, now });
    expect(await read("nidus-api", NOW - 1)).toMatchObject({ kind: "found" });
    expect(await read("nidus-api", NOW)).toMatchObject({ kind: "expired", credential: { project: "nidus-api" } });
    // The cloud did not say when it expires: the cloud is the one that says it no longer opens anything.
    expect(await read("forever", NOW + 10 ** 12)).toMatchObject({ kind: "found" });
  });

  it("does not use a file it cannot read, and says why without what it holds", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const read = () => readStoredCredential({ url: "https://cloud.example", project: "x" }, { ...access, now: NOW });

    await writeFile(path, '{"credentials":[{"token":"dtr_secret_in_a_broken_file"', { mode: 0o600 });
    const corrupt = await read();
    expect(corrupt).toMatchObject({ kind: "unusable" });
    expect(JSON.stringify(corrupt)).toContain(path);
    expect(JSON.stringify(corrupt)).not.toContain("dtr_");

    await writeFile(path, JSON.stringify({ schema: "downtrace.credentials/9", credentials: [] }), { mode: 0o600 });
    expect(await read()).toMatchObject({
      kind: "unusable",
      reason: expect.stringContaining("downtrace.credentials/9"),
    });

    await writeFile(path, JSON.stringify(["not", "the", "shape"]), { mode: 0o600 });
    expect(await read()).toMatchObject({ kind: "unusable" });
  });

  it("skips an entry that is not one, and reads the others", async () => {
    const { path, access } = await aStore();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = { schema: CREDENTIALS_SCHEMA, credentials: [{ url: "https://cloud.example" }, entry(), "nonsense"] };
    await writeFile(path, JSON.stringify(file), { mode: 0o600 });
    expect(
      await readStoredCredential({ url: "https://cloud.example", project: undefined }, { ...access, now: NOW }),
    ).toEqual({ kind: "found", credential: entry() });
  });

  it.skipIf(!posix)("refuses a file other users can read or write, and says how to close it", async () => {
    // covers: RF-611
    // Like ssh with a private key: a secret others could have read is not used as if it were still one.
    const { path, access } = await aStore();
    await storeCredential(entry(), access);
    for (const open of [0o640, 0o604, 0o620]) {
      await chmod(path, open);
      const read = await readStoredCredential(
        { url: "https://cloud.example", project: "nidus-api" },
        { ...access, now: NOW },
      );
      expect(read).toMatchObject({ kind: "unusable" });
      expect(JSON.stringify(read)).toContain(`chmod 600 ${path}`);
      expect(JSON.stringify(read)).not.toContain("dtr_");
    }
  });

  it.skipIf(!posix)("follows no symbolic link, and reads no file of another user", async () => {
    // covers: RF-611
    const { path, access } = await aStore();
    const elsewhere = credentialsPath({}, await aHome());
    await storeCredential(entry(), { path: elsewhere, uid });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, path);
    const read = await readStoredCredential(
      { url: "https://cloud.example", project: "nidus-api" },
      { ...access, now: NOW },
    );
    expect(read).toMatchObject({ kind: "unusable", reason: expect.stringContaining("symbolic link") });

    if (uid === undefined) return;
    const other = await readStoredCredential(
      { url: "https://cloud.example", project: "nidus-api" },
      { path: elsewhere, uid: uid + 1, now: NOW },
    );
    expect(other).toMatchObject({ kind: "unusable", reason: expect.stringContaining("another user") });
  });
});
