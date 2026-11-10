import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/init/command.ts";
import { instrumentFile, loadsInstrument, withFirstLine, withImportFlag } from "../src/init/files.ts";
import type { InitReport } from "../src/init/report.ts";

/**
 * DT-151: `downtrace init` writes the instrument file, with `init({ dsn })`, and the line that loads it, the way
 * `npx @sentry/wizard` does (RF-106): the entry's first line in CommonJS, `--import` in the start script for ES modules.
 * Run twice, it writes nothing twice.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A project in a directory of its own. `.git/` makes it a repository as init sees one. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-init-instrument-")));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (path.endsWith("/")) await mkdir(join(dir, path), { recursive: true });
    else await writeFile(join(dir, path), text);
  }
  return dir;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

async function init(dir: string): Promise<{ code: number; report: InitReport }> {
  const out: string[] = [];
  const code = await runInit({ cwd: dir, json: true, stdout: (text) => out.push(text) });
  return { code, report: JSON.parse(out.join("")) as InitReport };
}

async function initText(dir: string): Promise<string> {
  const out: string[] = [];
  await runInit({ cwd: dir, json: false, stdout: (text) => out.push(text) });
  return out.join("");
}

async function contents(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(dir.length + 1)] = await readFile(path, "utf8");
    }
  }
  return files;
}

const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), "utf8");

const NEST_MAIN = `import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
`;

/** A NestJS application as its CLI writes it: TypeScript compiled to CommonJS, the entry in `src/main.ts`. */
const NEST = {
  ".git/": "",
  "package.json": json({
    name: "nidus-api",
    dependencies: {
      "@nestjs/core": "^10.0.0",
      "@nestjs/common": "^10.0.0",
      "@nestjs/platform-express": "^10.0.0",
      "@downtrace/agent": "^0.21.0",
      pg: "^8.23.0",
    },
    scripts: { start: "nest start", "start:prod": "node dist/main", "test:e2e": "jest --config ./test/jest-e2e.json" },
  }),
  "tsconfig.json": `{\n  // comments, as Nest writes them\n  "compilerOptions": { "module": "commonjs", "outDir": "./dist" }\n}\n`,
  "nest-cli.json": json({ collection: "@nestjs/schematics", sourceRoot: "src" }),
  "src/main.ts": NEST_MAIN,
};

describe("a NestJS application compiled to CommonJS (RF-106)", () => {
  it("writes the instrument file with init({ dsn }), and imports it on the entry's first line", async () => {
    const dir = await project(NEST);
    const { code, report } = await init(dir);
    expect(code, JSON.stringify(report.missing)).toBe(0);
    expect(await read(dir, "src/instrument.ts")).toBe(instrumentFile("typescript"));
    expect(await read(dir, "src/instrument.ts")).toContain("init({ dsn: process.env.DOWNTRACE_DSN });");
    expect(await read(dir, "src/main.ts")).toBe(`import "./instrument";\n${NEST_MAIN}`);
    expect(report.files).toEqual(
      expect.arrayContaining([
        { path: "src/instrument.ts", action: "created" },
        { path: "src/main.ts", action: "updated" },
      ]),
    );
    expect(report.instrument).toEqual({ file: "src/instrument.ts", loadedBy: "src/main.ts", skipped: null });
  });

  it("run twice, writes nothing twice", async () => {
    const dir = await project(NEST);
    await init(dir);
    const before = await contents(dir);
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(await contents(dir)).toEqual(before);
    expect(report.files).toEqual(
      expect.arrayContaining([
        { path: "src/instrument.ts", action: "unchanged" },
        { path: "src/main.ts", action: "unchanged" },
      ]),
    );
  });

  it("finds the entry where nest-cli.json puts it", async () => {
    const { "src/main.ts": _main, ...rest } = NEST;
    const dir = await project({
      ...rest,
      "nest-cli.json": json({ sourceRoot: "apps/api/src", entryFile: "server" }),
      "apps/api/src/server.ts": NEST_MAIN,
    });
    const { report } = await init(dir);
    expect(report.instrument).toEqual({
      file: "apps/api/src/instrument.ts",
      loadedBy: "apps/api/src/server.ts",
      skipped: null,
    });
    expect(await read(dir, "apps/api/src/server.ts")).toBe(`import "./instrument";\n${NEST_MAIN}`);
  });

  it("leaves an instrument file the project has, and an entry that already loads it, as they are", async () => {
    const mine = `import { init } from "@downtrace/agent";\ninit({ dsn: "https://dt_mine@downtrace.example.com" });\n`;
    const main = `import "reflect-metadata";\nimport "./instrument";\n${NEST_MAIN}`;
    const dir = await project({ ...NEST, "src/instrument.ts": mine, "src/main.ts": main });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(await read(dir, "src/instrument.ts")).toBe(mine);
    expect(await read(dir, "src/main.ts")).toBe(main);
    expect(report.instrument).toMatchObject({ file: "src/instrument.ts", loadedBy: "src/main.ts" });
  });

  it("says what to add when the entry is not where it looks, and writes no file nothing would load", async () => {
    const { "src/main.ts": _main, ...rest } = NEST;
    const dir = await project(rest);
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing).toEqual([
      expect.objectContaining({
        code: "no-entry",
        advice: expect.stringContaining('import "./instrument";'),
      }),
    ]);
    expect(Object.keys(await contents(dir))).not.toContain("src/instrument.ts");
  });
});

describe("an ES module application (RF-106)", () => {
  const ESM = (scripts: Record<string, string>) => ({
    ".git/": "",
    "package.json": json({
      name: "shop",
      type: "module",
      dependencies: { express: "^5.2.1", "@downtrace/agent": "^0.21.0" },
      scripts: { test: "node --test", ...scripts },
    }),
    "server.js": `import express from "express";\nexpress().listen(3000);\n`,
  });

  it("writes instrument.mjs, and adds --import to the start script", async () => {
    const dir = await project(ESM({ start: "node server.js" }));
    const { code, report } = await init(dir);
    expect(code, JSON.stringify(report.missing)).toBe(0);
    expect(await read(dir, "instrument.mjs")).toBe(instrumentFile("esm"));
    const pkg = JSON.parse(await read(dir, "package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe("node --import ./instrument.mjs server.js");
    expect(report.instrument).toEqual({ file: "instrument.mjs", loadedBy: "scripts.start", skipped: null });
    expect(await read(dir, "server.js")).toBe(`import express from "express";\nexpress().listen(3000);\n`);
  });

  it("changes nothing else of package.json, and run twice writes nothing twice", async () => {
    const dir = await project(ESM({ start: "node server.js" }));
    const before = await read(dir, "package.json");
    await init(dir);
    expect(await read(dir, "package.json")).toBe(
      before.replace('"node server.js"', '"node --import ./instrument.mjs server.js"'),
    );
    const once = await contents(dir);
    const { report } = await init(dir);
    expect(await contents(dir)).toEqual(once);
    expect(report.files).toEqual(
      expect.arrayContaining([
        { path: "instrument.mjs", action: "unchanged" },
        { path: "package.json", action: "unchanged" },
      ]),
    );
  });

  it("with no start script it can edit, writes instrument.mjs and says what to add", async () => {
    const dir = await project(ESM({ start: "NODE_ENV=production node server.js" }));
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(await read(dir, "instrument.mjs")).toBe(instrumentFile("esm"));
    expect(report.missing).toEqual([
      expect.objectContaining({
        code: "no-start-script",
        advice: expect.stringContaining("--import ./instrument.mjs"),
      }),
    ]);
    expect(report.instrument).toEqual({ file: "instrument.mjs", loadedBy: null, skipped: null });
  });
});

describe("a CommonJS application in JavaScript (RF-106)", () => {
  it("writes instrument.js beside the entry, and requires it after the shebang and the directives", async () => {
    const entry = `#!/usr/bin/env node\n"use strict";\nconst express = require("express");\nexpress().listen(3000);\n`;
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { express: "^5.2.1", "@downtrace/agent": "^0.21.0" },
        main: "lib/server.js",
        scripts: { test: "node --test" },
      }),
      "lib/server.js": entry,
    });
    const { code, report } = await init(dir);
    expect(code, JSON.stringify(report.missing)).toBe(0);
    expect(await read(dir, "lib/instrument.js")).toBe(instrumentFile("commonjs"));
    expect(await read(dir, "lib/server.js")).toBe(
      `#!/usr/bin/env node\n"use strict";\nrequire("./instrument");\nconst express = require("express");\nexpress().listen(3000);\n`,
    );
    expect(report.instrument).toEqual({ file: "lib/instrument.js", loadedBy: "lib/server.js", skipped: null });
  });

  it("finds the entry in the start script when there is no main", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { fastify: "^5", "@downtrace/agent": "^0.21.0" },
        scripts: { start: "node --enable-source-maps app.js", test: "node --test" },
      }),
      "app.js": `const fastify = require("fastify")();\n`,
    });
    const { report } = await init(dir);
    expect(report.instrument).toEqual({ file: "instrument.js", loadedBy: "app.js", skipped: null });
    expect(await read(dir, "app.js")).toBe(`require("./instrument");\nconst fastify = require("fastify")();\n`);
  });
});

describe("what init does not instrument", () => {
  it("writes no instrument file when the package is only a dev dependency, which production does not install", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { express: "^5.2.1" },
        devDependencies: { "@downtrace/agent": "^0.21.0" },
        main: "server.js",
        scripts: { test: "node --test" },
      }),
      "server.js": `const express = require("express");\n`,
    });
    const { code, report } = await init(dir);
    expect(code).toBe(0);
    expect(report.status).toBe("configured");
    expect(await read(dir, "server.js")).toBe(`const express = require("express");\n`);
    expect(Object.keys(await contents(dir)).sort()).toEqual(["downtrace.json", "package.json", "server.js"]);
    expect(report.instrument).toEqual({
      file: null,
      loadedBy: null,
      skipped: expect.stringContaining("not a dependency"),
    });
    expect(await initText(dir)).toMatch(/production\s+not instrumented: /);
  });

  it("leaves a Next.js application to its own hook", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { next: "15.5.4", "@downtrace/agent": "^0.21.0" },
        scripts: { test: "vitest run" },
      }),
    });
    const { report } = await init(dir);
    expect(report.instrument).toBeNull();
  });

  it("says what to add when it cannot tell the entry of a TypeScript application", async () => {
    const dir = await project({
      ".git/": "",
      "package.json": json({
        dependencies: { express: "^5.2.1", "@downtrace/agent": "^0.21.0" },
        main: "dist/server.js",
        scripts: { start: "node dist/server.js", test: "node --test" },
      }),
      "tsconfig.json": "{}",
      "dist/server.js": `"use strict";\n`,
    });
    const { code, report } = await init(dir);
    expect(code).toBe(1);
    expect(report.missing).toEqual([expect.objectContaining({ code: "no-entry" })]);
    expect(await read(dir, "dist/server.js")).toBe(`"use strict";\n`);
  });
});

describe("the edits, one by one", () => {
  it("puts the line first, after a shebang, comments and directives, which must stay first", () => {
    expect(withFirstLine("a();\n", "L;")).toBe("L;\na();\n");
    expect(withFirstLine("#!/usr/bin/env node\na();\n", "L;")).toBe("#!/usr/bin/env node\nL;\na();\n");
    expect(withFirstLine("'use strict'\na();\n", "L;")).toBe("'use strict'\nL;\na();\n");
    expect(withFirstLine('/* MIT\n * licence\n */\n// more\n"use strict";\na();\n', "L;")).toBe(
      '/* MIT\n * licence\n */\n// more\n"use strict";\nL;\na();\n',
    );
  });

  it("knows an entry that loads the instrument file, however it spells it", () => {
    for (const text of [
      'require("./instrument");',
      "require('./instrument.js')",
      'import "./instrument";',
      "import './instrument.js';",
      'import {} from "./instrument";',
    ]) {
      expect(loadsInstrument(text), text).toBe(true);
    }
    expect(loadsInstrument('require("./instrumentation");')).toBe(false);
    expect(loadsInstrument('import "./lib/instrument";')).toBe(false);
  });

  it("adds --import after node, and nothing to what does not start with node", () => {
    expect(withImportFlag("node server.js")).toBe("node --import ./instrument.mjs server.js");
    expect(withImportFlag("node --enable-source-maps dist/main.js")).toBe(
      "node --import ./instrument.mjs --enable-source-maps dist/main.js",
    );
    expect(withImportFlag("nest start")).toBeUndefined();
    expect(withImportFlag("NODE_ENV=production node server.js")).toBeUndefined();
  });
});
