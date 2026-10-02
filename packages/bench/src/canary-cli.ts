import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { runCycle } from "./canary.ts";
import { canaryConfigFrom, createCanaryServer } from "./canary-server.ts";
import { cliArgs } from "./cli-args.ts";

// The canary's entry point: the only place it reads the environment. `canary-server.ts` says what it serves.
// It takes no flags, and a flag given anyway stops the start rather than being ignored.
let config: ReturnType<typeof canaryConfigFrom>;
try {
  parseArgs({ args: cliArgs(process.argv.slice(2)), options: {}, allowPositionals: false });
  config = canaryConfigFrom(process.env);
} catch (err) {
  console.error(`canary: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

// Stopping — a deployment replacing the container — aborts the cycle at its next wait: it switches the regression off
// and answers the request it was serving, and then the process exits. The compose file gives it the time to.
const stopping = new AbortController();
const server = createCanaryServer({
  run: (regression) =>
    runCycle(regression, config.cycle, {
      fetch,
      now: () => new Date(),
      sleep: (ms) => sleep(ms, undefined, { signal: stopping.signal }),
      signal: stopping.signal,
    }),
  log: (line) => console.log(line),
  now: () => new Date(),
});
server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      msg: "canary listening",
      port: config.port,
      app: config.cycle.appUrl,
      cloud: config.cycle.cloudUrl,
      project: config.cycle.project,
    }),
  );
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping.abort(signal);
    server.close(() => process.exit(0));
    // A request that will not end on its own does not hold the stop for ever.
    setTimeout(() => process.exit(0), 20_000).unref();
  });
}
