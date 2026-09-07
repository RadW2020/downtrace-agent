import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../src/process-sampler.ts";

/** Stand-in for the reference app's admin surface: records what it was asked and answers what the test wants. */
async function startApp(status: number): Promise<{ url: string; seen: { method: string; url: string }[] }> {
  const seen: { method: string; url: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(status).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe("resetDatabase", () => {
  it("posts to the app's reset endpoint", async () => {
    const app = await startApp(204);
    await resetDatabase(app.url);
    expect(app.seen).toEqual([{ method: "POST", url: "/__admin/db/reset" }]);
  });

  // A reset that quietly did not happen would put us back where gh-140 started: rounds that are not comparable
  // and nothing saying so. Every failure has to reach the caller.
  it("throws when the app refuses, naming the status", async () => {
    const app = await startApp(500);
    await expect(resetDatabase(app.url)).rejects.toThrow("/__admin/db/reset responded 500");
  });

  it("throws when the endpoint is not there at all (admin disabled)", async () => {
    const app = await startApp(404);
    await expect(resetDatabase(app.url)).rejects.toThrow("/__admin/db/reset responded 404");
  });

  it("throws when nobody answers", async () => {
    const app = await startApp(204);
    const dead = app.url;
    for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
    await expect(resetDatabase(dead)).rejects.toThrow();
  });
});
