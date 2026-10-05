import { appendFileSync, writeSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { Logger } from "./log.ts";

/**
 * Shows what would be sent, without sending it.
 *
 * `product.md` promises this twice, and it is the only way a user can check invariant 5 against **their** own
 * application: their route templates, their dependency hosts, their queries. Reading our source tells you what
 * the code intends; this tells you what your traffic actually produces (gh-181).
 *
 * What it writes is the **serialised body**, byte for byte, one JSON line per batch. Not a summary and not a
 * rendered view: something you can pipe through `jq`, or grep for the string you are afraid might escape. A
 * prettier output would be a different artefact from the one that travels, and then inspecting it proves nothing.
 */

/** Where the batches go. `stderr`, or a path to append to. */
export const STDERR = "stderr";

export interface Inspector {
  /** Writes one batch exactly as it would be sent. Never throws. */
  write(body: string): Promise<void>;
  /**
   * The same, and **blocking**: for the one moment nothing asynchronous runs again, `process.on("exit")`, which is
   * where a process that called `process.exit()` without waiting stops (DT-79, ADR 0230). Only the way out calls
   * it, and only in the inspection mode with no cloud behind it. Never throws.
   */
  writeOnExit(body: string): void;
}

/** The file descriptor of standard error, which a blocking write takes where `process.stderr.write` may not finish. */
const STDERR_FD = 2;

/** Nothing when no destination is configured: the inspection mode is off by absence, not by a flag. */
export function createInspector(destination: string | undefined, log: Logger): Inspector | undefined {
  if (destination === undefined || destination === "") return undefined;
  // A diagnostic tool that can take the application down is worse than no diagnostic tool (invariant 2), and a
  // destination that cannot be written is a mistake worth saying once rather than on every interval.
  let complained = false;
  const complain = (err: unknown): void => {
    if (complained) return;
    complained = true;
    const where = destination === STDERR ? "standard error" : `the inspection file ${destination}`;
    log.warn(
      `could not write ${where}: ${err instanceof Error ? err.message : String(err)}` +
        "; the instrumentation carries on and will not say this again",
    );
  };
  if (destination === STDERR) {
    return {
      write: async (body) => {
        process.stderr.write(`${body}\n`);
      },
      writeOnExit: (body) => {
        try {
          writeSync(STDERR_FD, `${body}\n`);
        } catch (err) {
          complain(err);
        }
      },
    };
  }
  return {
    write: async (body) => {
      try {
        await appendFile(destination, `${body}\n`);
      } catch (err) {
        complain(err);
      }
    },
    writeOnExit: (body) => {
      try {
        appendFileSync(destination, `${body}\n`);
      } catch (err) {
        complain(err);
      }
    },
  };
}
