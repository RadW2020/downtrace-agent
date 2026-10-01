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

const server = createCanaryServer({
  run: (regression) => runCycle(regression, config.cycle, { fetch, now: () => new Date(), sleep: (ms) => sleep(ms) }),
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
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
