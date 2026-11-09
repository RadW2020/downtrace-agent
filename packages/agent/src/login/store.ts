import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Where `downtrace login` keeps the access credentials it collected, the way `gh` keeps its own: `credentials.json` in
 * the user's configuration directory, the file readable by that user alone, in a directory only they open. One entry
 * per cloud and project; a new login of the same pair replaces the earlier entry, and the others stay.
 *
 * The file is data, not configuration: a command reads it when it needs a credential, not once at start-up, so a login
 * made in another terminal is seen without starting anything again. Its path is configuration, and is read once.
 *
 * Nothing here says what a credential is in an error: a reason names the file and what is wrong with it, never what
 * it holds. Not even the parser's message, which quotes the text around where it stopped.
 */

/** The shape of the file, versioned so a reader can tell one written by a later `downtrace`. */
export const CREDENTIALS_SCHEMA = "downtrace.credentials/1";

/** A credential login collected, under the cloud and the project it was asked of. */
export interface StoredCredential {
  /** The cloud's URL, as login was handed it. */
  url: string;
  /** The project's slug. */
  project: string;
  /** The environment login asked for. */
  environment: string;
  /** The environments it reaches. */
  environments: string[];
  /** `read` or `operate`. */
  level: string;
  /** What the cloud names it by. */
  id: string;
  /** The secret. */
  token: string;
  /** The person who approved it. */
  onBehalfOf: string;
  /** When it stops opening anything, RFC 3339; empty when the cloud did not say, and then the cloud is the judge. */
  expiresAt: string;
}

/** How the store reaches the file, passed in and not reached for. */
export interface StoreAccess {
  /** The file: `credentialsPath` of the environment. */
  path: string;
  /**
   * The user the file must belong to. Undefined where files have no POSIX owner (Windows), and then neither the owner
   * nor the mode is checked.
   */
  uid: number | undefined;
}

/** Why the credential could not be stored. Its message names the file and never what it holds. */
export class CredentialStoreError extends Error {}

/** `$XDG_CONFIG_HOME/downtrace/credentials.json`, or `~/.config/downtrace/credentials.json` without it. */
export function credentialsPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  // The XDG Base Directory specification: a relative path in the variable is invalid and is ignored.
  return join(xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config"), "downtrace", "credentials.json");
}

/**
 * Writes `entry` into the file, replacing the entry of its cloud and project. The file is written whole to a temporary
 * one beside it, created 0600 so that it is its user's alone from its first byte, and then renamed over it: a reader
 * sees the old file or the new one, never half of one. A file it cannot read is left as it is.
 */
export async function storeCredential(entry: StoredCredential, access: StoreAccess): Promise<void> {
  const dir = dirname(access.path);
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch((err: unknown) => {
    throw new CredentialStoreError(`${dir} could not be made (${codeOf(err)})`);
  });
  // `mkdir` accepts a directory that is a link to one elsewhere; this does not write through it.
  const directory = await lstat(dir).catch((err: unknown) => {
    throw new CredentialStoreError(`${dir} could not be read (${codeOf(err)})`);
  });
  if (directory.isSymbolicLink()) throw new CredentialStoreError(`${dir} is a symbolic link, which is not followed`);
  if (!directory.isDirectory()) throw new CredentialStoreError(`${dir} is not a directory`);
  if (access.uid !== undefined) {
    if (directory.uid !== access.uid) throw new CredentialStoreError(`${dir} belongs to another user`);
    if ((directory.mode & 0o077) !== 0) {
      await chmod(dir, 0o700).catch((err: unknown) => {
        throw new CredentialStoreError(`${dir} is open to other users and could not be closed (${codeOf(err)})`);
      });
    }
  }

  const existing = await readFile(access);
  if (existing.kind === "unusable") throw new CredentialStoreError(`${existing.reason}; it was left as it is`);
  const others = existing.kind === "read" ? existing.entries.filter((e) => !samePair(e, entry)) : [];
  const text = `${JSON.stringify({ schema: CREDENTIALS_SCHEMA, credentials: [...others, entry] }, null, 2)}\n`;

  const temporary = join(dir, `.credentials.json.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    // O_EXCL: a file that is already there, or a link in its place, is never the one written to.
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, access.path);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new CredentialStoreError(`${access.path} could not be written (${codeOf(err)})`);
  }
}

/** What a reader finds for a cloud and a project. */
export type StoredLookup =
  /** The credential to send. */
  | { kind: "found"; credential: StoredCredential }
  /** The entry is there and expired: it is not sent, and login is run again. */
  | { kind: "expired"; credential: StoredCredential }
  /** No entry for the pair; `projects` are the ones stored for the cloud. */
  | { kind: "missing"; projects: string[] }
  /** No project was named and the cloud has more than one stored: these. */
  | { kind: "ambiguous"; projects: string[] }
  /** The file is there and is not used: why, naming the file and not what it holds. */
  | { kind: "unusable"; reason: string };

/**
 * The stored credential of `url` and `project`; with no project, the only one stored for `url`. The file is read on
 * every call, and a file others can read or write, of another user, or that is a symbolic link, is not used: like
 * ssh with a private key, a secret others could have read is not used as if it were still one.
 */
export async function readStoredCredential(
  query: { url: string; project: string | undefined },
  access: StoreAccess & { now: number },
): Promise<StoredLookup> {
  const file = await readFile(access);
  if (file.kind === "unusable") return file;
  if (file.kind === "absent") return { kind: "missing", projects: [] };
  if (file.tooOpen) {
    return {
      kind: "unusable",
      reason:
        `${access.path} can be read or written by other users, so it is not used: run chmod 600 ${access.path}, ` +
        "or downtrace login again, which writes it 0600",
    };
  }
  const ofCloud = file.entries.filter((e) => cloudKey(e.url) === cloudKey(query.url));
  const projects = ofCloud.map((e) => e.project);
  let credential: StoredCredential | undefined;
  if (query.project !== undefined) credential = ofCloud.find((e) => e.project === query.project);
  else if (ofCloud.length > 1) return { kind: "ambiguous", projects };
  else credential = ofCloud[0];
  if (credential === undefined) return { kind: "missing", projects };
  const expires = credential.expiresAt === "" ? Number.NaN : Date.parse(credential.expiresAt);
  return { kind: expires <= access.now ? "expired" : "found", credential };
}

/** `O_NOFOLLOW` where the platform has it: a symbolic link in the file's place is not followed. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The file is small; one far larger is not one login wrote. */
const MAX_BYTES = 1024 * 1024;

type FileRead =
  | { kind: "absent" }
  | { kind: "read"; entries: StoredCredential[]; tooOpen: boolean }
  | { kind: "unusable"; reason: string };

/** The file's entries, read without following a link, from a file of its user. */
async function readFile(access: StoreAccess): Promise<FileRead> {
  const { path } = access;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "unusable", reason: `${path} is a symbolic link, which is not followed` };
    return { kind: "unusable", reason: `${path} could not be read (${code})` };
  }
  try {
    // Of the file opened, not of the path: what is checked is what is read.
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "unusable", reason: `${path} is not a file` };
    if (access.uid !== undefined && stat.uid !== access.uid) {
      return { kind: "unusable", reason: `${path} belongs to another user` };
    }
    if (stat.size > MAX_BYTES) return { kind: "unusable", reason: `${path} is larger than login writes` };
    const entries = parse(await handle.readFile("utf8"));
    if (typeof entries === "string") return { kind: "unusable", reason: `${path} ${entries}` };
    return { kind: "read", entries, tooOpen: access.uid !== undefined && (stat.mode & 0o077) !== 0 };
  } catch (err) {
    return { kind: "unusable", reason: `${path} could not be read (${codeOf(err)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The entries of the file's text, or what is wrong with it. An entry that is not one is skipped. */
function parse(text: string): StoredCredential[] | string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "is not JSON";
  }
  if (!isRecord(body)) return "is not the file login writes";
  if (body.schema !== CREDENTIALS_SCHEMA) {
    return `is not the file this version of downtrace reads (its schema is ${JSON.stringify(String(body.schema))}, not ${CREDENTIALS_SCHEMA})`;
  }
  if (!Array.isArray(body.credentials)) return "is not the file login writes";
  return body.credentials.flatMap((raw: unknown): StoredCredential[] => {
    if (!isRecord(raw)) return [];
    const text = (key: string): string => {
      const value = raw[key];
      return typeof value === "string" ? value : "";
    };
    const [url, project, token] = [text("url"), text("project"), text("token")];
    if (url === "" || project === "" || token === "") return [];
    return [
      {
        url,
        project,
        environment: text("environment"),
        environments: Array.isArray(raw.environments)
          ? raw.environments.filter((e): e is string => typeof e === "string")
          : [],
        level: text("level"),
        id: text("id"),
        token,
        onBehalfOf: text("onBehalfOf"),
        expiresAt: text("expiresAt"),
      },
    ];
  });
}

function samePair(a: StoredCredential, b: StoredCredential): boolean {
  return a.project === b.project && cloudKey(a.url) === cloudKey(b.url);
}

/** A cloud's URL as the same cloud compares: its origin and its path, without the trailing slashes. */
function cloudKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error's code, `EACCES` and the like, which says what failed without saying what was in the file. */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "an error with no code";
}
