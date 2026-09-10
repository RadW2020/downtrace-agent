/** Read once, at start-up, and validated there. `process.env` appears nowhere else (repo rule). */

export interface Config {
  /** Where the cloud is. */
  url: string;
  /**
   * An access credential of level `operate`, or empty. Empty is a working configuration and not an error:
   * the server comes up read-only and every operation says so when it is called, which is more use to a
   * coding agent than refusing to start.
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
