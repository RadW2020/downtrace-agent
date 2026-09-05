import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const REF_APP_MAIN = fileURLToPath(new URL("../../reference-app/src/main.ts", import.meta.url));
const REF_APP_ENV_FILE = fileURLToPath(new URL("../../reference-app/.env", import.meta.url));

export interface AppHandle {
  pid: number;
  port: number;
  baseUrl: string;
  /** The first distinct error lines the app wrote to stderr after it started listening (at most MAX_ERROR_LINES). */
  firstErrors(): readonly string[];
  stop(): Promise<void>;
}

export const MAX_ERROR_LINES = 5;

/** `{"level":"error","status":503,"method":"GET","path":"/me","error":"ColdStartError","message":"…"}` → one readable line. */
export function summarizeErrorLine(line: string): string {
  try {
    const e = JSON.parse(line) as {
      status?: unknown;
      method?: unknown;
      path?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (typeof e.status === "number" && typeof e.error === "string") {
      const where = typeof e.method === "string" && typeof e.path === "string" ? ` ${e.method} ${e.path}` : "";
      const msg = typeof e.message === "string" && e.message !== "" ? `: ${e.message}` : "";
      return `${e.status}${where} ${e.error}${msg}`;
    }
  } catch {
    // not JSON: keep the raw line
  }
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export interface StartOptions {
  /** Module preloaded with `node --import` (the agent, or a fixture). Absolute path. */
  importPath?: string | undefined;
  env?: Record<string, string> | undefined;
  readyTimeoutMs?: number | undefined;
}

/**
 * Starts packages/reference-app/src/main.ts in a child Node process on random
 * ports and waits for its "listening" line. The reference app never depends on
 * the agent: whatever is measured is injected here, by absolute path.
 */
export function startReferenceApp(opts: StartOptions = {}): Promise<AppHandle> {
  const args = [`--env-file-if-exists=${REF_APP_ENV_FILE}`];
  if (opts.importPath) args.push("--import", pathToFileURL(opts.importPath).href);
  args.push(REF_APP_MAIN);

  const child = spawn(process.execPath, args, {
    env: { ...process.env, PORT: "0", PROVIDER_PORT: "0", ADMIN_ENABLED: "1", REGRESSIONS: "", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const { stdout, stderr: stderrPipe } = child;
  if (!stdout || !stderrPipe) throw new Error("reference app process has no stdio pipes");

  return new Promise<AppHandle>((resolve, reject) => {
    const stderr: string[] = [];
    let listening = false;
    const errorLines: string[] = [];
    stderrPipe.on("data", (d: Buffer) => {
      if (!listening) stderr.push(d.toString());
    });
    createInterface({ input: stderrPipe }).on("line", (line) => {
      if (!listening || line.trim() === "" || errorLines.length >= MAX_ERROR_LINES) return;
      const summary = summarizeErrorLine(line);
      if (!errorLines.includes(summary)) errorLines.push(summary);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`reference app did not start within ${opts.readyTimeoutMs ?? 30_000} ms\n${stderr.join("")}`));
    }, opts.readyTimeoutMs ?? 30_000);

    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`reference app exited with code ${code} before listening\n${stderr.join("")}`));
    });

    createInterface({ input: stdout }).on("line", (line) => {
      let msg: { msg?: string; port?: number } | undefined;
      try {
        msg = JSON.parse(line) as { msg?: string; port?: number };
      } catch {
        return;
      }
      if (msg.msg === "reference-app listening" && typeof msg.port === "number") {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        listening = true;
        const port = msg.port;
        resolve({
          pid: child.pid ?? -1,
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          firstErrors: () => errorLines,
          stop: () => stop(child),
        });
      }
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
