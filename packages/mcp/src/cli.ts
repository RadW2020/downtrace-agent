#!/usr/bin/env node
import { ConfigError, configFrom } from "./config.ts";
import { linesOf } from "./rpc.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

/**
 * What a coding agent's configuration points at. Speaks JSON-RPC on stdin and stdout, so **nothing else may
 * ever be written to stdout**: a stray `console.log` would be a malformed message to the client. Diagnostics
 * go to stderr, which is what a client shows the user.
 */
try {
  const config = configFrom((name) => process.env[name]);
  if (config.token === "") {
    process.stderr.write("downtrace-mcp: no DOWNTRACE_TOKEN, so this session can read but not operate\n");
  }
  const server = createServer({ config, version: VERSION });
  await server.run(linesOf(process.stdin), (line) => process.stdout.write(line));
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`downtrace-mcp: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
