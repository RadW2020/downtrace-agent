#!/usr/bin/env node
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { ConfigError, configFrom, credentialsPathFrom, httpConfigFrom } from "./config.ts";
import { readStoredCredential } from "./credentials.ts";
import { createHttpServer } from "./http.ts";
import { linesOf } from "./rpc.ts";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";

/**
 * What a coding agent's configuration points at. Speaks JSON-RPC on stdin and stdout, so **nothing else may
 * ever be written to stdout**: a stray `console.log` would be a malformed message to the client. Diagnostics
 * go to stderr, which is what a client shows the user.
 *
 * With `--http` it serves MCP's Streamable HTTP transport instead, at `/mcp/<project>`, with the credential each
 * request carries (RF-513). Which transport is an argument, because it is no secret; everything else is the
 * environment's, read once here.
 */
try {
  const get = (name: string) => process.env[name];
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--http");
  if (unknown.length > 0) {
    throw new ConfigError(`unknown argument ${unknown.join(" ")}: downtrace-mcp takes --http, or nothing for stdio`);
  }
  const config = configFrom(get);
  if (args.includes("--http")) {
    const http = httpConfigFrom(get);
    if (config.token !== "") {
      process.stderr.write(
        "downtrace-mcp: DOWNTRACE_TOKEN is not used over HTTP: each request sends its own credential\n",
      );
    }
    const server = createHttpServer({
      url: config.url,
      publicUrl: http.publicUrl,
      origins: http.origins,
      version: VERSION,
    });
    server.on("error", (err) => {
      process.stderr.write(`downtrace-mcp: cannot serve HTTP on ${http.host}:${http.port}: ${err.message}\n`);
      process.exit(1);
    });
    server.listen(http.port, http.host, () => {
      const { port } = server.address() as AddressInfo;
      const host = http.host.includes(":") ? `[${http.host}]` : http.host;
      process.stderr.write(
        `downtrace-mcp: serving MCP over HTTP at http://${host}:${port}/mcp/<project>, for ${config.url}\n`,
      );
    });
    // In a container this is process 1, which no signal stops unless it says how: stop taking requests, answer the
    // ones in flight, then exit.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => server.close(() => process.exit(0)));
    }
  } else {
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
  }
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`downtrace-mcp: ${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
