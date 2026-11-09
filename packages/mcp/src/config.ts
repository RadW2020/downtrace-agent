import { isAbsolute, join } from "node:path";

/** Read once, at start-up, and validated there. `process.env` appears nowhere else (repo rule). */

export interface Config {
  /** Where the cloud is. */
  url: string;
  /**
   * An access credential of level `operate`, or empty. Empty is a working configuration and not an error: each
   * call sends the credential `downtrace login` stored for this cloud and its project, and with none stored the
   * server reads without a credential and every operation says what it needs when it is called, which is more use
   * to a coding agent than refusing to start.
   */
  token: string;
}

export class ConfigError extends Error {}

export function configFrom(get: (name: string) => string | undefined): Config {
  const url = (get("DOWNTRACE_URL") ?? "").trim().replace(/\/$/, "");
  if (url === "") {
    throw new ConfigError("DOWNTRACE_URL is required: it is where this server reaches the cloud");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError(`DOWNTRACE_URL must be an http(s) URL, got ${JSON.stringify(url)}`);
  }
  // From the environment and never from an argument: an argument ends up in a process list and in a shell
  // history, and this one is a credential that can close findings.
  return { url, token: (get("DOWNTRACE_TOKEN") ?? "").trim() };
}

/**
 * How the server listens when it speaks HTTP (`--http`, RF-513). No credential is configured: each request carries its
 * own, and `DOWNTRACE_TOKEN` and the stored credentials are not read.
 */
export interface HttpConfig {
  host: string;
  port: number;
  /**
   * The origin clients reach this server at, which its metadata names as the resource and its `Origin` check accepts.
   * Empty on the loopback: the origin is then the request's `Host`, which must be a loopback name.
   */
  publicUrl: string;
  /** The origins a browser's `Origin` may be besides the server's own. */
  origins: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function httpConfigFrom(get: (name: string) => string | undefined): HttpConfig {
  const host = (get("DOWNTRACE_MCP_HOST") ?? "").trim() || "127.0.0.1";
  const rawPort = (get("DOWNTRACE_MCP_PORT") ?? "").trim();
  const port = rawPort === "" ? 8787 : Number(rawPort);
  if (!/^\d{0,5}$/.test(rawPort) || port > 65535) {
    throw new ConfigError(`DOWNTRACE_MCP_PORT must be a port, 0 to 65535, got ${JSON.stringify(rawPort)}`);
  }
  const rawPublic = (get("DOWNTRACE_MCP_PUBLIC_URL") ?? "").trim();
  const publicUrl = rawPublic === "" ? "" : originOf("DOWNTRACE_MCP_PUBLIC_URL", rawPublic);
  if (publicUrl === "" && !LOOPBACK.has(host)) {
    // Off the loopback, the `Host` a request names is anybody's to choose: a page that rebinds its own name to this
    // server would be accepted as this server's own origin.
    throw new ConfigError(
      `DOWNTRACE_MCP_HOST is ${host}, not a loopback address, so DOWNTRACE_MCP_PUBLIC_URL is required: the URL clients ` +
        "reach this server at, which its metadata names and its Origin check accepts",
    );
  }
  const origins = (get("DOWNTRACE_MCP_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .map((o) => originOf("DOWNTRACE_MCP_ORIGINS", o));
  return { host, port, publicUrl, origins };
}

/** An origin, scheme and host and nothing after them, in the form a browser sends it in `Origin`. */
function originOf(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    u = new URL("invalid:");
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.username !== "" ||
    u.password !== "" ||
    u.pathname !== "/" ||
    u.search !== "" ||
    u.hash !== ""
  ) {
    throw new ConfigError(
      `${name} must be an origin, a scheme and a host with no path, such as https://downtrace.example.com: ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return u.origin;
}

/**
 * Where `downtrace login` keeps the access credentials: `$XDG_CONFIG_HOME/downtrace/credentials.json`, or under
 * `~/.config` without it. The path is configuration, and is read here once; the file is data, read on each call that
 * needs it (`credentials.ts`).
 */
export function credentialsPathFrom(get: (name: string) => string | undefined, home: string): string {
  const xdg = (get("XDG_CONFIG_HOME") ?? "").trim();
  // The XDG Base Directory specification: a relative path in the variable is invalid and is ignored.
  return join(xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config"), "downtrace", "credentials.json");
}
