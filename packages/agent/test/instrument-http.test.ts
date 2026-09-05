import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enterRequest, type RequestContext } from "../src/context.ts";
import { instrumentHttp } from "../src/instrument/http.ts";
import type { Logger } from "../src/log.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

let server: http.Server;
let port: number;
let stop: () => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/boom") {
      res.writeHead(503).end("no");
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  port = (server.address() as AddressInfo).port;
  stop = instrumentHttp(quiet);
});

afterAll(async () => {
  stop();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Outgoing HTTP as one request's work, once the responses have been observed. */
async function workOf(ctx: RequestContext) {
  await new Promise((r) => setTimeout(r, 50));
  return [...(ctx.work ?? new Map())].map(([, w]) => w).filter((w) => w.kind === "http");
}

describe("instrumentHttp", () => {
  it("records a fetch call against the request that made it, under the host it asked for", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe(`127.0.0.1:${port}`);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(0);
    expect(dep?.ms).toBeGreaterThan(0);
  });

  it("counts a 5xx from the dependency as a failure of that dependency", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("counts a node:http call that never connected", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      const request = http.get({ host: "127.0.0.1", port: 1, path: "/nowhere" });
      request.on("error", () => done());
    });
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("counts a fetch that never connected, which undici does not publish", async () => {
    const ctx = enterRequest();
    await expect(fetch("http://127.0.0.1:1/nowhere")).rejects.toThrow();
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe("127.0.0.1:1");
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("does not count a successful fetch twice, now that fetch is wrapped as well as listened to", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
  });

  it("does not count a 5xx twice either: the channels saw it, so the wrapper stays out", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/boom`);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(1);
    expect(dep?.errors).toBe(1);
  });

  it("puts fetch back when it stops observing", async () => {
    const before = globalThis.fetch;
    const undo = instrumentHttp(quiet);
    expect(globalThis.fetch).not.toBe(before);
    undo();
    expect(globalThis.fetch).toBe(before);
  });

  it("groups calls by host, so two dependencies are not one", async () => {
    const ctx = enterRequest();
    await fetch(`http://127.0.0.1:${port}/a`);
    await fetch(`http://localhost:${port}/a`);
    const deps = await workOf(ctx);
    expect(deps.map((d) => d.target).sort()).toEqual([`127.0.0.1:${port}`, `localhost:${port}`]);
  });

  it("records the node:http client too, under the same host label as fetch would", async () => {
    const ctx = enterRequest();
    await new Promise<void>((done) => {
      http.get({ host: "127.0.0.1", port, path: "/b" }, (res) => {
        res.resume();
        res.on("end", () => done());
      });
    });
    const [dep] = await workOf(ctx);
    expect(dep?.target).toBe(`127.0.0.1:${port}`);
    expect(dep?.calls).toBe(1);
  });

  it("counts several calls to the same host as several calls of one dependency", async () => {
    const ctx = enterRequest();
    await Promise.all([
      fetch(`http://127.0.0.1:${port}/a`),
      fetch(`http://127.0.0.1:${port}/a`),
      fetch(`http://127.0.0.1:${port}/a`),
    ]);
    const [dep] = await workOf(ctx);
    expect(dep?.calls).toBe(3);
  });

  it("ignores calls made outside a request", async () => {
    // No enterRequest here: this call belongs to no endpoint, like a health probe at startup.
    const response = await fetch(`http://127.0.0.1:${port}/a`);
    expect(response.status).toBe(200);
  });
});
