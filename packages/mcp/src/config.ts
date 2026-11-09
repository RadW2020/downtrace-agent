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
 * Where `downtrace login` keeps the access credentials: `$XDG_CONFIG_HOME/downtrace/credentials.json`, or under
 * `~/.config` without it. The path is configuration, and is read here once; the file is data, read on each call that
 * needs it (`credentials.ts`).
 */
export function credentialsPathFrom(get: (name: string) => string | undefined, home: string): string {
  const xdg = (get("XDG_CONFIG_HOME") ?? "").trim();
  // The XDG Base Directory specification: a relative path in the variable is invalid and is ignored.
  return join(xdg !== "" && isAbsolute(xdg) ? xdg : join(home, ".config"), "downtrace", "credentials.json");
}
