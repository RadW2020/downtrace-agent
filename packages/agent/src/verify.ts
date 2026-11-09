import { DESTINATION_PATH } from "@downtrace/protocol";
import { configFromEnv, splitDsn } from "./config.ts";
import { destinationOf } from "./transport.ts";

/** How long the check may take: a cloud that takes the connection and never answers is one of the answers. */
export const VERIFY_TIMEOUT_MS = 10_000;

export interface VerifyDeps {
  /** `--dsn`. With it, the environment's connection is not read. */
  dsn: string | undefined;
  /** `--token` and `--url`, which go together. With them, the environment's connection is not read. */
  token: string | undefined;
  url: string | undefined;
  /** The environment, read once at start-up: where the token comes from when no flag gives it. */
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * `downtrace verify` (RF-507): asks the cloud where a token writes, with no batch, and says it.
 *
 * The token is the one the instrumentation would use: `DOWNTRACE_DSN`, or `DOWNTRACE_TOKEN` and `DOWNTRACE_URL`, read
 * as the instrumentation reads them, unless `--dsn` or `--token` and `--url` give another. It is never printed, and
 * neither is a DSN, which carries it.
 *
 * Exit status: 0 the token writes where it says, 1 the cloud refused the token, 2 nothing could be checked — no token,
 * a cloud that cannot be reached, does not answer in time, or answers something else — as `check`'s 2 is «no
 * comparison could be made».
 */
export async function runVerify(deps: VerifyDeps): Promise<number> {
  const fail = (text: string, code: 1 | 2 = 2): number => {
    deps.stderr(`downtrace verify: ${text}\n`);
    return code;
  };
  const cloud = cloudOf(deps);
  if ("reason" in cloud) return fail(cloud.reason);
  const { token, url } = cloud;
  const timeoutMs = deps.timeoutMs ?? VERIFY_TIMEOUT_MS;

  // One deadline for the request and its body, and the command's own signal on top of it. By hand rather than with
  // `AbortSignal.any`, which Node 20 only has from 20.3, and the CLI runs on every Node 20.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const interrupt = (): void => controller.abort();
  deps.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    let status: number;
    let body: string;
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${url}${DESTINATION_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      status = res.status;
      body = await res.text();
    } catch (err) {
      if (timedOut) return fail(`the cloud at ${url} did not answer within ${timeoutMs / 1000} s`);
      if (deps.signal?.aborted) return fail("interrupted before the cloud answered");
      return fail(`could not reach the cloud at ${url}: ${causeOf(err)}`);
    }
    if (status === 200) {
      const where = destinationOf(parsed(body));
      if (where === undefined) return fail(`the cloud at ${url} answered 200 with something that is not a destination`);
      deps.stdout(
        where.environment === undefined
          ? `downtrace verify: the token writes to ${where.project}, in the environment each batch declares (DOWNTRACE_ENV)\n`
          : `downtrace verify: the token writes to ${where.project} / ${where.environment}\n`,
      );
      return 0;
    }
    if (status === 401) {
      return fail(`the cloud at ${url} refused the token (401): it does not know it, or it was revoked`, 1);
    }
    if (status === 404) {
      return fail(
        `the cloud at ${url} cannot check a token (404): it is older than protocol 0.14.0, or it is not a Downtrace cloud`,
      );
    }
    if (status === 429) {
      return fail(
        `the cloud at ${url} asked to wait (429): too many failed attempts from this address, or this token's rate is spent`,
      );
    }
    return fail(`the cloud at ${url} answered ${status}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", interrupt);
  }
}

/**
 * The token and the cloud's URL: from `--dsn`, from `--token` and `--url`, or else from the environment as the
 * instrumentation reads it. Or why there are none, which never echoes the token or the DSN.
 */
function cloudOf(deps: VerifyDeps): { token: string; url: string } | { reason: string } {
  if (deps.dsn !== undefined) return splitDsn(deps.dsn, "--dsn");
  if (deps.token !== undefined && deps.url !== undefined) {
    if (!/^https?:\/\//.test(deps.url)) return { reason: "--url must start with http:// or https://" };
    return { token: deps.token, url: deps.url.replace(/\/+$/, "") };
  }
  const read = configFromEnv(deps.env, []);
  const advice = "; or pass --dsn, or --token and --url";
  if (!read.ok) return { reason: `nothing to check: ${read.reason}${advice}` };
  if (read.config.token === "" || read.config.url === "") {
    return { reason: `nothing to check: no cloud is set, only DOWNTRACE_INSPECT, which writes locally${advice}` };
  }
  return { token: read.config.token, url: read.config.url };
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** What made the request fail, in a line: Node's `fetch` says only «fetch failed», and the reason is its cause. */
export function causeOf(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : cause.message;
  }
  return err instanceof Error ? err.message : String(err);
}
