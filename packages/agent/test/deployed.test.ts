import { channel } from "node:diagnostics_channel";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { AggregatesBatch } from "@downtrace/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import {
  type Chosen,
  CODE_PREFIX,
  codeFingerprint,
  DeployedVersion,
  IMAGE_PREFIX,
  imageDigest,
  lookFurther,
  STAMP_FILE,
} from "../src/deployed.ts";
import type { Logger } from "../src/log.ts";
import { testConfig } from "./support/agent-config.ts";

/**
 * DT-130: the deployed version is found on any deploy platform, with no configuration. Past the variables (tested in
 * `config.test.ts`) the start-up asks the runtime's metadata — the ECS task metadata, here served by a real HTTP server,
 * so that `fetch`'s own timeout and body are what is tested — and then fingerprints the code. And whatever it finds, a
 * process says one version for its whole life.
 */

const quiet: Logger = { warn: () => {}, debug: () => {} };
const DIGEST = `sha256:${"d6".repeat(32)}`;
const CODE = /^code:[0-9a-f]{16}$/;

/** The container's metadata as the ECS agent answers it, abridged. */
const METADATA = JSON.stringify({
  DockerId: "ea32192c8553fbff06c9340478a2ff089b2bb5646fb718b4ee206641c9086d66",
  Name: "api",
  Image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/api:latest",
  ImageID: DIGEST,
  Labels: { "com.amazonaws.ecs.task-definition-family": "api" },
});

let server: Server;
let base: string;
const scratch: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        res.writeHead(200, { "content-type": "application/json" }).end(METADATA);
        return;
      case "/fails":
        res.writeHead(500).end("internal error");
        return;
      case "/slow":
        // Never answers: the request is left open until the server closes.
        return;
      case "/not-json":
        res.writeHead(200, { "content-type": "text/html" }).end("<html>a proxy's login page</html>");
        return;
      case "/no-digest":
        res.writeHead(200).end(JSON.stringify({ Image: "api:latest" }));
        return;
      case "/pause-container":
        res.writeHead(200).end(JSON.stringify({ Image: "amazon/amazon-ecs-pause:0.1.0", ImageID: "" }));
        return;
      case "/not-an-object":
        res.writeHead(200).end(JSON.stringify([DIGEST]));
        return;
      case "/huge":
        res.writeHead(200).end(JSON.stringify({ ImageID: DIGEST, padding: "x".repeat(200_000) }));
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** A directory of this test's own, removed at the end. */
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "downtrace-deployed-"));
  scratch.push(dir);
  return dir;
}

/** Writes `files`, by their path from `root`. */
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A NestJS build as a container holds it: the code, the manifests, its dependencies, and what it writes as it runs. */
const BUILD = {
  "package.json": '{"name":"api","version":"1.0.0"}',
  "package-lock.json": '{"lockfileVersion":3,"packages":{"node_modules/pg":{"version":"8.12.0"}}}',
  "dist/main.js": "require('./app.module');",
  "dist/app.module.js": "exports.AppModule = class {};",
  "dist/users/users.service.js": "exports.find = () => repo.find({ take: 10 });",
  "src/main.ts": "import './app.module';",
  "node_modules/pg/package.json": '{"name":"pg","version":"8.12.0"}',
  "node_modules/pg/index.js": "module.exports = {};",
  ".git/HEAD": "ref: refs/heads/main",
  "logs/app.log": "started\n",
  "data/store.json": '{"sessions":1}',
};

/** A build unpacked somewhere new, and the fingerprint of its entry. */
async function deploy(
  files: Record<string, string> = BUILD,
  entry = "dist/main.js",
): Promise<{ root: string; answer: Awaited<ReturnType<typeof codeFingerprint>> }> {
  const root = await scratchDir();
  await write(root, files);
  return { root, answer: await codeFingerprint({ entry: join(root, entry), signal: new AbortController().signal }) };
}

function versionOf(answer: Awaited<ReturnType<typeof codeFingerprint>>): string {
  if ("passed" in answer) throw new Error(`no fingerprint: ${answer.passed}`);
  return answer.version;
}

describe("the image digest, from the ECS task metadata", () => {
  const ask = (path: string, timeoutMs = 2_000) => imageDigest({ uri: `${base}${path}`, fetchImpl: fetch, timeoutMs });

  it("is the container's ImageID, said as an image's and not as a commit", async () => {
    expect(await ask("/ok")).toEqual({ version: `${IMAGE_PREFIX}${DIGEST}`, source: "the ECS task metadata" });
  });

  it("is passed over when the endpoint fails", async () => {
    expect(await ask("/fails")).toEqual({ passed: "the ECS task metadata answered 500" });
  });

  it("is passed over when the endpoint is slow, at its timeout", async () => {
    // The server never answers: without the timeout this would not return at all, and the test would time out.
    expect(await ask("/slow", 150)).toEqual({ passed: "the ECS task metadata did not answer within 150 ms" });
  });

  // covers: RF-107
  it("is read after a synchronous start longer than its timeout: the application's load counts once, however long", async () => {
    // DT-223: on Fargate the digest was never used. The question is asked as the instrumentation starts, and then the
    // application loads its modules in one synchronous stretch, seconds on a small task. A timer on the wall clock
    // expired during it and fired as soon as it ended, before the answer was read.
    const asked = ask("/ok", 150);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    expect(await asked).toEqual({ version: `${IMAGE_PREFIX}${DIGEST}`, source: "the ECS task metadata" });
  });

  it.each([
    ["not JSON", "/not-json"],
    ["JSON with no digest", "/no-digest"],
    ["a pause container's empty digest", "/pause-container"],
    ["JSON that is not an object", "/not-an-object"],
  ])("is passed over when the endpoint returns garbage: %s", async (_what, path) => {
    expect(await ask(path)).toEqual({ passed: "the ECS task metadata named no image digest" });
  });

  it("reads no more than a bounded answer", async () => {
    expect(await ask("/huge")).toEqual({ passed: "the ECS task metadata answered more than 65536 bytes" });
  });

  it("is passed over when nothing listens, and when fetch itself throws", async () => {
    const refused = await imageDigest({ uri: "http://127.0.0.1:1/v4/x", fetchImpl: fetch, timeoutMs: 2_000 });
    expect("passed" in refused && refused.passed).toMatch(/^the ECS task metadata could not be read/);
    const throwing = (() => {
      throw new Error("a fetch that throws");
    }) as unknown as typeof fetch;
    expect(await imageDigest({ uri: `${base}/ok`, fetchImpl: throwing, timeoutMs: 2_000 })).toEqual({
      passed: "the ECS task metadata could not be read: a fetch that throws",
    });
  });
});

describe("the fingerprint of the deployed code", () => {
  it("is the same for two instances of one build, wherever each is unpacked", async () => {
    const one = await deploy();
    const other = await deploy();
    expect(one.root).not.toBe(other.root);
    expect(versionOf(one.answer)).toMatch(CODE);
    expect(versionOf(other.answer)).toBe(versionOf(one.answer));
  });

  it("is the same after a restart, and after what the application writes as it runs", async () => {
    const { root, answer } = await deploy();
    // What a running application writes into its own directory: a log, its data, a newer time on every file.
    await write(root, { "logs/app.log": "started\nstarted again\n", "data/store.json": '{"sessions":42}' });
    const later = new Date("2030-01-01T00:00:00Z");
    for (const file of ["dist/main.js", "dist/users/users.service.js", "package.json"]) {
      await utimes(join(root, file), later, later);
    }
    const restarted = await codeFingerprint({
      entry: join(root, "dist/main.js"),
      signal: new AbortController().signal,
    });
    expect(versionOf(restarted)).toBe(versionOf(answer));
  });

  it("differs for two builds whose code differs, even by a character of the same size deep in the tree", async () => {
    const before = await deploy();
    const after = await deploy({
      ...BUILD,
      "dist/users/users.service.js": BUILD["dist/users/users.service.js"].replace("10", "50"),
    });
    expect(versionOf(after.answer)).not.toBe(versionOf(before.answer));
  });

  it("differs when only the lockfile does: the same code on other dependencies is another deploy", async () => {
    const before = await deploy();
    const after = await deploy({
      ...BUILD,
      "package-lock.json": BUILD["package-lock.json"].replace("8.12.0", "8.13.0"),
    });
    expect(versionOf(after.answer)).not.toBe(versionOf(before.answer));
  });

  it("does not read node_modules nor version control", async () => {
    const before = await deploy();
    const after = await deploy({
      ...BUILD,
      "node_modules/pg/index.js": "module.exports = { changed: true };",
      ".git/HEAD": "ref: refs/heads/other",
      ".git/hooks/pre-commit.js": "process.exit(1)",
    });
    expect(versionOf(after.answer)).toBe(versionOf(before.answer));
  });

  it("reads the root from the closest package.json above the entry, and the entry may be its directory", async () => {
    const { root, answer } = await deploy();
    const fromDirectory = await codeFingerprint({ entry: `${root}${sep}`, signal: new AbortController().signal });
    expect(versionOf(fromDirectory)).toBe(versionOf(answer));
    expect("source" in answer && answer.source).toBe(`a fingerprint of 6 files under ${root}`);
  });

  it("is the entry alone when no package.json is above it", async () => {
    const dir = await scratchDir();
    await write(dir, { "server.js": "require('http').createServer().listen(3000);", "notes.js": "a" });
    const entry = join(dir, "server.js");
    const first = await codeFingerprint({ entry, signal: new AbortController().signal });
    await write(dir, { "notes.js": "b" });
    expect(versionOf(await codeFingerprint({ entry, signal: new AbortController().signal }))).toBe(versionOf(first));
    await write(dir, { "server.js": "require('http').createServer().listen(3001);" });
    expect(versionOf(await codeFingerprint({ entry, signal: new AbortController().signal }))).not.toBe(
      versionOf(first),
    );
  });

  it("follows no symbolic link out of the root", async () => {
    const outside = await scratchDir();
    await write(outside, { "lib/index.js": "one" });
    const { root, answer } = await deploy();
    await symlink(join(outside, "lib"), join(root, "dist/linked"));
    await symlink(join(outside, "lib/index.js"), join(root, "dist/linked.js"));
    await write(outside, { "lib/index.js": "two" });
    const again = await codeFingerprint({ entry: join(root, "dist/main.js"), signal: new AbortController().signal });
    expect(versionOf(again)).toBe(versionOf(answer));
  });

  it("stops at its limit of files, at the same place on every instance, and says so", async () => {
    const limits = { files: 3, bytes: 1024 * 1024 };
    const roots = [await scratchDir(), await scratchDir()];
    for (const root of roots) await write(root, BUILD);
    const [one, other] = await Promise.all(
      roots.map((root) =>
        codeFingerprint({ entry: join(root, "dist/main.js"), signal: new AbortController().signal, limits }),
      ),
    );
    expect(versionOf(other ?? { passed: "" })).toBe(versionOf(one ?? { passed: "" }));
    expect(one && "source" in one && one.source).toMatch(/a fingerprint of 3 files under .*, the first 3 in the order/);
    // The manifests at the root are read before any directory, so they are inside the cut.
    const root = roots[0] ?? "";
    await write(root, { "package-lock.json": "{}" });
    const changed = await codeFingerprint({
      entry: join(root, "dist/main.js"),
      signal: new AbortController().signal,
      limits,
    });
    expect(versionOf(changed)).not.toBe(versionOf(one ?? { passed: "" }));
  });

  it("counts a file past its limit of bytes by its path and its size", async () => {
    const limits = { files: 100, bytes: 80 };
    const fingerprint = async (files: Record<string, string>): Promise<string> => {
      const root = await scratchDir();
      await write(root, files);
      return versionOf(
        await codeFingerprint({ entry: join(root, "server.js"), signal: new AbortController().signal, limits }),
      );
    };
    const app = { "package.json": "{}", "server.js": "x".repeat(100) };
    const sameSize = await fingerprint({ ...app, "server.js": "y".repeat(100) });
    expect(sameSize).toBe(await fingerprint(app));
    expect(await fingerprint({ ...app, "server.js": "x".repeat(101) })).not.toBe(await fingerprint(app));
  });

  it("has no answer once its budget has passed", async () => {
    const root = await scratchDir();
    await write(root, BUILD);
    const budget = new AbortController();
    budget.abort();
    expect(await codeFingerprint({ entry: join(root, "dist/main.js"), signal: budget.signal })).toEqual({
      passed: "the fingerprint did not finish within its budget",
    });
  });

  it("has no answer when there is no code: a directory with no package.json above it", async () => {
    const dir = await scratchDir();
    const answer = await codeFingerprint({ entry: `${dir}${sep}`, signal: new AbortController().signal });
    expect("passed" in answer && answer.passed).toMatch(/^no code to fingerprint/);
  });
});

describe("the chain past the variables", () => {
  const entryOf = async (): Promise<string> => join((await deploy()).root, "dist/main.js");

  it("takes the image digest on ECS", async () => {
    const chosen = await lookFurther({
      ecsMetadataUri: `${base}/ok`,
      entry: await entryOf(),
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: quiet.warn,
    });
    expect(chosen).toEqual({ version: `${IMAGE_PREFIX}${DIGEST}`, source: "the ECS task metadata" });
  });

  it.each([
    ["fails", "/fails", "answered 500"],
    ["is slow", "/slow", "did not answer within 150 ms"],
    ["returns garbage", "/not-json", "named no image digest"],
  ])("moves on to the fingerprint when the endpoint %s, and says what it passed over", async (_what, path, said) => {
    const chosen = await lookFurther({
      ecsMetadataUri: `${base}${path}`,
      entry: await entryOf(),
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: quiet.warn,
      metadataTimeoutMs: 150,
    });
    expect(chosen.version).toMatch(CODE);
    expect(chosen.source).toContain(`the ECS task metadata ${said}`);
  });

  it("fingerprints the code anywhere else", async () => {
    const chosen = await lookFurther({
      ecsMetadataUri: undefined,
      entry: await entryOf(),
      fetchImpl: () => {
        throw new Error("nothing is asked off ECS");
      },
      signal: new AbortController().signal,
      warn: quiet.warn,
    });
    expect(chosen.version.startsWith(CODE_PREFIX)).toBe(true);
  });

  it("is unknown when there is nothing to read either, and says why", async () => {
    const dir = await scratchDir();
    const chosen = await lookFurther({
      ecsMetadataUri: `${base}/fails`,
      entry: `${dir}${sep}`,
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: quiet.warn,
    });
    expect(chosen.version).toBe("unknown");
    expect(
      chosen.source.startsWith(
        `no ${STAMP_FILE} in ${dir}; the ECS task metadata answered 500; no code to fingerprint`,
      ),
    ).toBe(true);
  });
});

describe("the commit downtrace stamp wrote", () => {
  const COMMIT = "3f2a9c1e5b7d4a6f8e0c2b4d6f8a0c2e4b6d8f0a";

  /** The chain on a build with `files`, on an ECS task whose endpoint answers with a digest; and what it warned. */
  async function chainOn(files: Record<string, string>, entry = "dist/main.js") {
    const root = await scratchDir();
    await write(root, files);
    const warnings: string[] = [];
    const chosen = await lookFurther({
      ecsMetadataUri: `${base}/ok`,
      entry: join(root, entry),
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: (message) => warnings.push(message),
    });
    return { root, chosen, warnings };
  }

  // covers: RF-122
  it("is the version, before the image digest and the fingerprint, with no prefix: it is a commit", async () => {
    const { root, chosen, warnings } = await chainOn({ ...BUILD, [STAMP_FILE]: `${COMMIT}\n` });
    expect(chosen).toEqual({ version: COMMIT, source: `${join(root, STAMP_FILE)}, which downtrace stamp wrote` });
    expect(warnings).toEqual([]);
  });

  // covers: RF-122
  it("takes an abbreviated commit, and one in capitals, as the same commit in small letters", async () => {
    expect((await chainOn({ ...BUILD, [STAMP_FILE]: "3f2a9c1" })).chosen.version).toBe("3f2a9c1");
    expect((await chainOn({ ...BUILD, [STAMP_FILE]: `  ${COMMIT.toUpperCase()}\r\n` })).chosen.version).toBe(COMMIT);
  });

  // covers: RF-122
  it("is read from the code's root, the closest directory above the entry with a package.json, and not beside it", async () => {
    const atRoot = await chainOn({ ...BUILD, [STAMP_FILE]: COMMIT }, "dist/main.js");
    expect(atRoot.chosen.version).toBe(COMMIT);
    const besideEntry = await chainOn({ ...BUILD, [`dist/${STAMP_FILE}`]: COMMIT }, "dist/main.js");
    expect(besideEntry.chosen.version).toBe(`${IMAGE_PREFIX}${DIGEST}`);
  });

  // covers: RF-122
  it("is read beside the entry when no package.json is above it: a bundle copied alone", async () => {
    const { chosen } = await chainOn({ "server.js": "require('http');", [STAMP_FILE]: COMMIT }, "server.js");
    expect(chosen.version).toBe(COMMIT);
  });

  // covers: RF-122
  it("is passed over without a word when there is none, and the debug line says where it was looked for", async () => {
    const { root, chosen, warnings } = await chainOn(BUILD);
    expect(chosen.version).toBe(`${IMAGE_PREFIX}${DIGEST}`);
    expect(warnings).toEqual([]);
    const fingerprinted = await lookFurther({
      ecsMetadataUri: undefined,
      entry: join(root, "dist/main.js"),
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: (message) => warnings.push(message),
    });
    expect(fingerprinted.version).toMatch(CODE);
    expect(fingerprinted.source.endsWith(`(no ${STAMP_FILE} in ${root})`)).toBe(true);
    expect(warnings).toEqual([]);
  });

  // covers: RF-122
  it.each([
    ["a version that is not a commit", "v1.4.2"],
    ["six hexadecimal digits", "3f2a9c"],
    ["forty-one", `${COMMIT}0`],
    ["an empty file", ""],
    ["a commit and a second line", `${COMMIT}\nsecret=hunter2`],
    ["a commit and a long tail", `${COMMIT}${" ".repeat(4_000)}secret=hunter2`],
  ])(
    "is ignored with one warning, which does not repeat it, when it holds %s, and the chain goes on",
    async (_what, content) => {
      const { root, chosen, warnings } = await chainOn({ ...BUILD, [STAMP_FILE]: content });
      expect(chosen.version).toBe(`${IMAGE_PREFIX}${DIGEST}`);
      expect(warnings).toEqual([
        `${join(root, STAMP_FILE)} holds no commit (7 to 40 hexadecimal digits): it is ignored, and the version is looked for further`,
      ]);
      expect(warnings.join("")).not.toContain("hunter2");
    },
  );

  // covers: RF-122
  it("is ignored with one warning when it cannot be read, and the chain goes on", async () => {
    const root = await scratchDir();
    await write(root, BUILD);
    await mkdir(join(root, STAMP_FILE));
    const warnings: string[] = [];
    const chosen = await lookFurther({
      ecsMetadataUri: undefined,
      entry: join(root, "dist/main.js"),
      fetchImpl: fetch,
      signal: new AbortController().signal,
      warn: (message) => warnings.push(message),
    });
    expect(chosen.version).toMatch(CODE);
    expect(warnings).toEqual([
      `${join(root, STAMP_FILE)} could not be read (EISDIR): the version is looked for further`,
    ]);
    expect(chosen.source).toContain(`${join(root, STAMP_FILE)} could not be read (EISDIR)`);
  });
});

/** A logger that keeps its debug lines. */
function recording(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: { warn: () => {}, debug: (line) => lines.push(line) }, lines };
}

/** A promise and the function that settles it, for a search that answers when the test says. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("one version for the life of the process", () => {
  const found: Chosen = { version: `${IMAGE_PREFIX}${DIGEST}`, source: "the ECS task metadata" };

  it("keeps what a variable named, and says once which one", () => {
    const { log, lines } = recording();
    const version = new DeployedVersion({ log });
    version.named({ version: "8f71ac2", source: "CODEBUILD_RESOLVED_SOURCE_VERSION" });
    version.search(async () => found, 1_000);
    expect([version.read(), version.read()]).toEqual(["8f71ac2", "8f71ac2"]);
    expect(lines).toEqual(["version: 8f71ac2, from CODEBUILD_RESOLVED_SOURCE_VERSION"]);
  });

  it("takes what the search found, once it is ready", async () => {
    const { log, lines } = recording();
    const version = new DeployedVersion({ log });
    version.search(async () => found, 1_000);
    expect(version.open).toBe(true);
    await version.ready();
    expect(version.read()).toBe(found.version);
    expect(lines).toEqual([`version: ${found.version}, from the ECS task metadata`]);
  });

  it("never replaces a version a batch has said: a search that answers after the first read is dropped", async () => {
    const { log, lines } = recording();
    const version = new DeployedVersion({ log });
    const late = deferred<Chosen>();
    version.search(() => late.promise, 1_000);
    expect(version.read()).toBe("unknown");
    late.resolve(found);
    await version.ready();
    expect(version.read()).toBe("unknown");
    expect(lines).toEqual(["version: unknown, from the first batch left before the search had finished"]);
  });

  it("is unknown when the search never answers, once its budget has passed", async () => {
    const { log, lines } = recording();
    const version = new DeployedVersion({ log });
    version.search(() => new Promise<Chosen>(() => {}), 50);
    await version.ready();
    expect(version.read()).toBe("unknown");
    expect(lines).toEqual(["version: unknown, from no source answered within 50 ms"]);
  });

  it("is unknown when the search fails or throws, and nothing of it reaches the caller", async () => {
    for (const look of [
      () => Promise.reject(new Error("rejected")),
      () => {
        throw new Error("thrown");
      },
    ]) {
      const { log, lines } = recording();
      const version = new DeployedVersion({ log });
      expect(() => version.search(look, 1_000)).not.toThrow();
      await version.ready();
      expect(version.read()).toBe("unknown");
      expect(lines[0]).toMatch(/^version: unknown, from the search failed: (rejected|thrown)$/);
    }
  });

  it("lets a wait end at its own deadline while the search goes on", async () => {
    const version = new DeployedVersion({ log: quiet });
    const late = deferred<Chosen>();
    version.search(() => late.promise, 10_000);
    await version.ready(AbortSignal.timeout(20));
    expect(version.open).toBe(true);
    late.resolve(found);
    await version.ready();
    expect(version.read()).toBe(found.version);
  });
});

describe("the version the agent's batches carry", () => {
  const METADATA_URI = "http://169.254.170.2/v4/abc";
  const agents: { stop: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.stop();
  });

  /** An agent whose batches land in `batches`, and whose `fetch` answers the metadata endpoint with `metadata`. */
  function agentWith(options: {
    config?: Partial<AgentConfig>;
    metadata?: () => Response;
    lookForVersion?: (signal: AbortSignal) => Promise<Chosen>;
    versionBudgetMs?: number;
    log?: Logger;
  }) {
    const batches: AggregatesBatch[] = [];
    const asked: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === METADATA_URI) {
        asked.push(url);
        return options.metadata?.() ?? new Response(null, { status: 404 });
      }
      batches.push(JSON.parse(String(init?.body)) as AggregatesBatch);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const agent = createAgent(
      testConfig("http://sink.invalid", {
        environment: "test",
        intervalMs: 60_000,
        instrument: new Set(),
        ...options.config,
      }),
      {
        log: options.log ?? quiet,
        fetchImpl,
        lookForVersion: options.lookForVersion,
        versionBudgetMs: options.versionBudgetMs,
      },
    );
    agents.push(agent);
    return { agent, batches, asked };
  }

  /** One request, so the flush has an interval to send. */
  function serve(): void {
    const request = { method: "GET", url: "/orders" };
    channel("http.server.request.start").publish({ request });
    channel("http.server.response.finish").publish({ request, response: { statusCode: 200 } });
  }

  const ecs = { ecsMetadataUri: METADATA_URI };
  const metadata = () => new Response(METADATA, { status: 200 });

  it("is the image digest on an ECS task with none of the variables", async () => {
    const { agent, batches, asked } = agentWith({ config: ecs, metadata });
    agent.start();
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual([`${IMAGE_PREFIX}${DIGEST}`]);
    expect(asked).toEqual([METADATA_URI]);
  });

  it("is DOWNTRACE_VERSION whatever else the chain would find, and nothing is asked", async () => {
    const { agent, batches, asked } = agentWith({
      config: { ...ecs, version: "v1.4.2", versionFrom: "DOWNTRACE_VERSION" },
      metadata,
    });
    agent.start();
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual(["v1.4.2"]);
    expect(asked).toEqual([]);
  });

  it("looks for nothing when a variable says unknown: what a variable names is taken as named", async () => {
    const { agent, batches, asked } = agentWith({
      config: { ...ecs, version: "unknown", versionFrom: "DOWNTRACE_VERSION" },
      metadata,
    });
    agent.start();
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual(["unknown"]);
    expect(asked).toEqual([]);
  });

  it("is a fingerprint of the code when the endpoint fails, the same for two instances of one build", async () => {
    const versions: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { agent, batches } = agentWith({ config: ecs, metadata: () => new Response("no", { status: 500 }) });
      agent.start();
      serve();
      await agent.flushNow();
      versions.push(batches[0]?.deploy.version ?? "");
    }
    expect(versions[0]).toMatch(CODE);
    expect(versions[1]).toBe(versions[0]);
  });

  it("does not delay the start, and nothing the search throws reaches the application", async () => {
    const { agent, batches } = agentWith({
      lookForVersion: () => {
        throw new Error("a search that throws");
      },
    });
    expect(() => agent.start()).not.toThrow();
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual(["unknown"]);
    expect(agent.stats.internalErrors).toBe(0);
  });

  it("makes the first batch wait for the search, and every batch carries what it found", async () => {
    const answer = deferred<Chosen>();
    const { agent, batches } = agentWith({ lookForVersion: () => answer.promise });
    agent.start();
    serve();
    const first = agent.flushNow();
    setTimeout(() => answer.resolve({ version: "code:0123456789abcdef", source: "a test" }), 50);
    await first;
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual(["code:0123456789abcdef", "code:0123456789abcdef"]);
  });

  it("waits a bounded time: past the budget the first batch says unknown, and so does every batch after", async () => {
    const answer = deferred<Chosen>();
    const { agent, batches } = agentWith({ lookForVersion: () => answer.promise, versionBudgetMs: 50 });
    agent.start();
    serve();
    await agent.flushNow();
    answer.resolve({ version: "code:0123456789abcdef", source: "a test" });
    serve();
    await agent.flushNow();
    expect(batches.map((b) => b.deploy.version)).toEqual(["unknown", "unknown"]);
  });

  it("says once, with DOWNTRACE_DEBUG, which source chose the version", async () => {
    const { log, lines } = recording();
    const { agent } = agentWith({ config: ecs, metadata, log });
    agent.start();
    serve();
    await agent.flushNow();
    await agent.flushNow();
    expect(lines.filter((line) => line.startsWith("version:"))).toEqual([
      `version: ${IMAGE_PREFIX}${DIGEST}, from the ECS task metadata`,
    ]);
  });

  it("withholds what it found in minimal mode, as it withholds a version a variable names", async () => {
    const { agent, batches } = agentWith({ config: { ...ecs, minimal: true }, metadata });
    agent.start();
    serve();
    await agent.flushNow();
    expect(batches[0]?.deploy.version).toMatch(/^#[0-9a-f]{16}$/);
  });
});
