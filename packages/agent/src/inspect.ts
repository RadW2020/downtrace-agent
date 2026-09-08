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
}

/** Nothing when no destination is configured: the inspection mode is off by absence, not by a flag. */
export function createInspector(destination: string | undefined, log: Logger): Inspector | undefined {
  if (destination === undefined || destination === "") return undefined;
  if (destination === STDERR) {
    return {
      write: async (body) => {
        process.stderr.write(`${body}\n`);
      },
    };
  }
  // A diagnostic tool that can take the application down is worse than no diagnostic tool (invariant 2), and a
  // destination that cannot be written is a mistake worth saying once rather than on every interval.
  let complained = false;
  return {
    write: async (body) => {
      try {
        await appendFile(destination, `${body}\n`);
      } catch (err) {
        if (complained) return;
        complained = true;
        log.warn(
          `could not write the inspection file ${destination}: ${err instanceof Error ? err.message : String(err)}` +
            "; the instrumentation carries on and will not say this again",
        );
      }
    },
  };
}
