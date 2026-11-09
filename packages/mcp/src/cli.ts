#!/usr/bin/env node
import { homedir } from "node:os";
import { ConfigError, configFrom, credentialsPathFrom } from "./config.ts";
import { readStoredCredential } from "./credentials.ts";
import { linesOf } from "./rpc.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

/**
 * What a coding agent's configuration points at. Speaks JSON-RPC on stdin and stdout, so **nothing else may
 * ever be written to stdout**: a stray `console.log` would be a malformed message to the client. Diagnostics
 * go to stderr, which is what a client shows the user.
 */
try {
  const get = (name: string) => process.env[name];
  const config = configFrom(get);
  const path = credentialsPathFrom(get, homedir());
  const uid = process.getuid?.();
  if (config.token === "") {
    process.stderr.write(
      `downtrace-mcp: no DOWNTRACE_TOKEN, so each call sends the credential downtrace login stored in ${path} ` +
        `for ${config.url} and the call's project\n`,
    );
  }
  const server = createServer({
    config,
    version: VERSION,
    credentials: (project) => readStoredCredential({ url: config.url, project }, { path, uid, now: Date.now() }),
  });
  await server.run(linesOf(process.stdin), (line) => process.stdout.write(line));
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`downtrace-mcp: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
