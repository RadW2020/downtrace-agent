export interface Logger {
  warn(message: string): void;
  debug(message: string): void;
}

const PREFIX = "[downtrace]";

/** Minimal stderr logger. `debug` lines only appear with DOWNTRACE_DEBUG. */
export function createLogger(debug: boolean, write: (line: string) => void = defaultWrite): Logger {
  return {
    warn: (message) => write(`${PREFIX} ${message}`),
    debug: (message) => {
      if (debug) write(`${PREFIX} ${message}`);
    },
  };
}

function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}
