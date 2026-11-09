import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

/**
 * The access credentials `downtrace login` keeps, read the way `@downtrace/agent` writes them: `credentials.json` in
 * the user's configuration directory, one entry per cloud and project. This server has no dependencies (ADR 0078), so
 * the reader is its own, and a test holds it to login's writer.
 *
 * The file is data, not configuration: its path is read once at start-up (`config.ts`), and the file on each call
 * that needs a credential from it, so a login made during the session —a new project, or a credential that replaced
 * an expired or a revoked one— is used at the next call without a restart. It is a few hundred bytes beside a
 * request to the cloud.
 *
 * A reason names the file and what is wrong with it, never what it holds: not even the parser's message, which quotes
 * the text around where it stopped.
 */

/** The shape of the file login writes, versioned. */
export const CREDENTIALS_SCHEMA = "downtrace.credentials/1";

/** One entry of the file. */
export interface StoredCredential {
  url: string;
  project: string;
  environment: string;
  level: string;
  token: string;
  /** RFC 3339; empty when the cloud did not say, and then the cloud is the judge. */
  expiresAt: string;
}

/** What the file holds for a cloud and a project. */
export type StoredLookup =
  /** The credential to send. */
  | { kind: "found"; credential: StoredCredential }
  /** The entry is there and expired: it is not sent. */
  | { kind: "expired"; credential: StoredCredential }
  /** No entry for the pair; `projects` are the ones stored for the cloud. */
  | { kind: "missing"; projects: string[] }
  /** No project was named and the cloud has more than one stored: these. */
  | { kind: "ambiguous"; projects: string[] }
  /** The file is there and is not used: why. */
  | { kind: "unusable"; reason: string };

/**
 * The stored credential of `url` and `project`; with no project, the only one stored for `url`. A file others can read
 * or write, of another user, or that is a symbolic link is not used: like ssh with a private key, a secret others could
 * have read is not used as if it were still one. `uid` is undefined where files have no POSIX owner, and then neither
 * the owner nor the mode is checked.
 */
export async function readStoredCredential(
  query: { url: string; project: string | undefined },
  access: { path: string; uid: number | undefined; now: number },
): Promise<StoredLookup> {
  const file = await readFile(access.path, access.uid);
  if (file.kind === "unusable") return file;
  if (file.kind === "absent") return { kind: "missing", projects: [] };
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
  | { kind: "read"; entries: StoredCredential[] }
  | { kind: "unusable"; reason: string };

async function readFile(path: string, uid: number | undefined): Promise<FileRead> {
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
    if (uid !== undefined && stat.uid !== uid) return { kind: "unusable", reason: `${path} belongs to another user` };
    if (uid !== undefined && (stat.mode & 0o077) !== 0) {
      return {
        kind: "unusable",
        reason:
          `${path} can be read or written by other users, so it is not used: run chmod 600 ${path}, or ` +
          "downtrace login again, which writes it 0600",
      };
    }
    if (stat.size > MAX_BYTES) return { kind: "unusable", reason: `${path} is larger than login writes` };
    const entries = parse(await handle.readFile("utf8"));
    if (typeof entries === "string") return { kind: "unusable", reason: `${path} ${entries}` };
    return { kind: "read", entries };
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
    return `is not the file this server reads (its schema is ${JSON.stringify(String(body.schema))}, not ${CREDENTIALS_SCHEMA})`;
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
      { url, project, token, environment: text("environment"), level: text("level"), expiresAt: text("expiresAt") },
    ];
  });
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

/** The error's code, `EACCES` and the like, which says what failed without what was in the file. */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "an error with no code";
}
