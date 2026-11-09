import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, type StoredCredential, storeCredential } from "../../src/login/store.ts";

/**
 * A cloud on this machine for `downtrace brief` and `downtrace api`: it answers what each test scripts, and keeps
 * every request it got, so that a test can say none was sent.
 */

/** What the stand-in answers a request: a status and a body, or `hang` (it never answers). */
export type Answer = { status: number; body: string; headers?: Record<string, string> } | "hang";

export interface StandIn {
  url: string;
  /** Every request it got: its method, its path with the query, and the credential it carried. */
  seen: { method: string; path: string; authorization: string | undefined }[];
}

const servers: Server[] = [];
const homes: string[] = [];

/** Closes the stand-ins and takes the home directories away: for an `afterEach`. */
export async function cleanUp(): Promise<void> {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
}

/** A cloud that answers each request with what `answer` says for its path. */
export async function standIn(answer: (path: string) => Answer): Promise<StandIn> {
  const seen: StandIn["seen"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
    const a = answer(req.url ?? "");
    if (a === "hang") return;
    res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
    res.end(a.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** A JSON answer. */
export const json = (status: number, body: unknown): Answer => ({ status, body: `${JSON.stringify(body)}\n` });

/** A home directory of its own under the system's temporary one, never the user's. */
export async function aHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "downtrace-read-"));
  homes.push(home);
  return home;
}

/** Stores `entries` in `home` as `downtrace login` would, with what an entry leaves out filled in. */
export async function stored(home: string, entries: (Partial<StoredCredential> & { url: string })[]): Promise<void> {
  for (const entry of entries) {
    await storeCredential(
      {
        project: "nidus-api",
        environment: "production",
        environments: ["production"],
        level: "read",
        id: "cred_1",
        token: "dtr_stored",
        onBehalfOf: "someone",
        expiresAt: "",
        ...entry,
      },
      { path: credentialsPath({}, home), uid: process.getuid?.() },
    );
  }
}
