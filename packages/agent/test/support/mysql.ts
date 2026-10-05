import { createRequire } from "node:module";
import type { Server as NetServer, Socket } from "node:net";
import type * as Mysql2 from "mysql2";
import type { Connection as ServerSideConnection } from "mysql2";

/**
 * A MySQL server in this process, spoken to by the real `mysql2` client (DT-91).
 *
 * `mysql2` carries its own server half of the protocol, so a test can run the real driver — its pool, its
 * connection queue, its callbacks, its promise wrapper and the errors it builds from the server's packets —
 * against a server it controls, with no database and no Docker. What the instrumentation is asked to do is
 * attribute what the driver does, and a stand-in for the driver would be a stand-in for the answer.
 *
 * It answers the text protocol (`query`, which is what `mysql2` uses for every `query()`); prepared statements
 * (`execute`) need a server that knows how to prepare, and the real-MySQL test covers them.
 */

/** What the server does with one query. */
export interface Reply {
  /** Waits this long before answering, so a query is slow and a pool has time to run out. */
  delayMs?: number;
  /** An error packet instead of a result. */
  error?: { code: number; message: string };
}

export interface FakeMysql {
  host: string;
  port: number;
  /** The texts the server received, in order, as they came over the wire: with the values the client put in. */
  received: string[];
  /** How many connections it has accepted. */
  accepted: () => number;
  close: () => Promise<void>;
}

const COLUMNS = [
  {
    catalog: "def",
    schema: "",
    table: "",
    orgTable: "",
    name: "one",
    orgName: "",
    characterSet: 33,
    columnLength: 1,
    columnType: 8,
    flags: 129,
    decimals: 0,
  },
];

export async function startFakeMysql(handler: (sql: string) => Reply = () => ({})): Promise<FakeMysql> {
  const mysql = createRequire(import.meta.url)("mysql2") as typeof Mysql2;
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = mysql.createServer((connection: ServerSideConnection) => {
    accepted += 1;
    const side = connection as ServerSideConnection & { _resetSequenceId: () => void; stream: Socket };
    sockets.add(side.stream);
    side.stream.on("close", () => sockets.delete(side.stream));
    // Every command starts its sequence at zero; the server half does not do that by itself, and `mysql2` says
    // so on stderr once per command. Reset after each thing written, the handshake's included.
    for (const write of ["writeOk", "writeError", "writeTextResult"] as const) {
      const original = side[write].bind(side) as (...args: unknown[]) => void;
      (side as unknown as Record<string, unknown>)[write] = (...args: unknown[]) => {
        original(...args);
        side._resetSequenceId();
      };
    }
    side.serverHandshake({
      protocolVersion: 10,
      serverVersion: "8.0.0-downtrace-fake",
      connectionId: accepted,
      statusFlags: 2,
      characterSet: 8,
      capabilityFlags: 0xffffff,
    });
    side.on("query", (sql: string) => {
      received.push(sql);
      const reply = handler(sql);
      const answer = (): void => {
        if (side.stream.destroyed) return;
        if (reply.error) side.writeError(reply.error);
        else side.writeTextResult([{ one: 1 }], COLUMNS);
      };
      if (reply.delayMs) setTimeout(answer, reply.delayMs);
      else answer();
    });
    side.on("quit", () => side.stream.end());
    side.on("error", () => {});
  });
  server.listen(0);
  const net = (server as unknown as { _server: NetServer })._server;
  await new Promise<void>((resolve) => (net.listening ? resolve() : net.once("listening", resolve)));
  const address = net.address();
  if (address === null || typeof address === "string") throw new Error("the fake MySQL server has no port");
  return {
    host: "127.0.0.1",
    port: address.port,
    received,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        net.close(() => resolve());
      }),
  };
}

/** The copies of `mysql2` the tests have: the current one, and the layout that came before it (see `ownerOf`). */
export type Driver = "mysql2" | "mysql2-legacy";

/**
 * Its own copy of `mysql2`, with its own classes, so that a test patches the prototypes it is about and no other
 * test meets them. The patch lives on a prototype, a prototype lives in the module cache, and a pool builds its
 * connections from classes it requires itself — so a subclass would not reach them, and a copy does.
 *
 * `mysql2-legacy` is 3.11.5, where a pooled connection is not a `Connection` (it is from 3.20): the layout that
 * most applications installed today still have, and the one the first version of the observer could not see.
 */
export function freshMysql2(driver: Driver = "mysql2"): typeof Mysql2 {
  const require = createRequire(import.meta.url);
  // Both copies live in directories called `mysql2`, and a copy's modules require each other by relative path.
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]node_modules[\\/]mysql2[\\/]/.test(key)) delete require.cache[key];
  }
  return require(driver) as typeof Mysql2;
}

/** The same, for the promise wrapper of that copy: it requires the copy's `index.js`, which is the fresh one. */
export function freshMysql2Promise(driver: Driver = "mysql2"): typeof import("mysql2/promise") {
  return createRequire(import.meta.url)(`${driver}/promise`) as typeof import("mysql2/promise");
}
