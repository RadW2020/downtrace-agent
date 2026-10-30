import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE,
  declaredRoute,
  findConfig,
  INSTALLING_VERBS,
  installIn,
  PACKAGE_MANAGERS,
  parseConfig,
  shellJoin,
} from "../src/check/config.ts";

/**
 * `downtrace.json`: the one place a project says how its tests are run, which `downtrace init` writes and
 * `downtrace check` reads. The format is small on purpose, and strict inside `check`: a key this file does not know
 * is a typo, and a typo left alone is a missing command said in the wrong words.
 */

const run = promisify(execFile);

describe("reading the configuration", () => {
  it("reads every key", () => {
    const text = JSON.stringify({
      check: {
        command: "npm test",
        prepare: "pnpm run scss",
        link: true,
        routes: ["get /products", "POST /checkout"],
        timeout: 120,
      },
    });
    expect(parseConfig(text, "x")).toEqual({
      ok: true,
      config: {
        command: "npm test",
        prepare: "pnpm run scss",
        link: true,
        routes: ["GET /products", "POST /checkout"],
        timeoutSeconds: 120,
      },
    });
  });

  it("takes a command written as a list of words, and quotes what a shell would split", () => {
    const parsed = parseConfig(JSON.stringify({ check: { command: ["npm", "test", "--", "-t", "a b"] } }), "x");
    expect(parsed).toMatchObject({ ok: true, config: { command: "npm test -- -t 'a b'" } });
  });

  it("is fine with nothing to say: a file with no check, or no keys in it", () => {
    for (const text of ["{}", '{"check":{}}', '{"other":1}']) {
      expect(parseConfig(text, "x")).toMatchObject({ ok: true, config: { command: undefined, routes: [] } });
    }
  });

  it("leaves link unsaid when the file does not say it: whether the base is linked then follows prepare", () => {
    for (const text of [
      "{}",
      '{"check":{}}',
      '{"check":{"prepare":"npm run scss"}}',
      '{"check":{"command":"npm test"}}',
    ]) {
      expect(parseConfig(text, "x")).toMatchObject({ ok: true, config: { link: undefined } });
    }
  });

  it("reads link as written, false with no prepare included: a key that says false is not linked", () => {
    expect(parseConfig('{"check":{"link":false}}', "x")).toMatchObject({ ok: true, config: { link: false } });
    expect(parseConfig('{"check":{"link":true}}', "x")).toMatchObject({ ok: true, config: { link: true } });
    expect(parseConfig('{"check":{"link":false,"prepare":"npm ci"}}', "x")).toMatchObject({
      ok: true,
      config: { link: false, prepare: "npm ci" },
    });
  });

  it("does not judge the keys outside check, which are not its to judge", () => {
    expect(parseConfig('{"project":"x","check":{"command":"npm test"}}', "x").ok).toBe(true);
  });

  it.each([
    ["not JSON", "{nope", "not JSON"],
    ["a list", "[]", "must be a JSON object"],
    ["a check that is not an object", '{"check":"npm test"}', '"check" must be an object'],
    ["a key it does not know", '{"check":{"commmand":"npm test"}}', '"check.commmand" is not a key'],
    ["a command that is a number", '{"check":{"command":3}}', '"check.command" must be'],
    ["an empty command", '{"check":{"command":" "}}', '"check.command" must be'],
    ["a command list with a number in it", '{"check":{"command":["npm",1]}}', '"check.command" must be'],
    ["a prepare that is not a string", '{"check":{"prepare":true}}', '"check.prepare" must be'],
    ["a link that is a string", '{"check":{"link":"true"}}', '"check.link" must be true or false'],
    ["a link that is a number", '{"check":{"link":1}}', '"check.link" must be true or false'],
    ["a link that is null", '{"check":{"link":null}}', '"check.link" must be true or false'],
    [
      "a link that is a list of directories",
      '{"check":{"link":["node_modules"]}}',
      '"check.link" must be true or false',
    ],
    ["routes that are not a list", '{"check":{"routes":"GET /a"}}', '"check.routes" must be a list'],
    ["a route with no method", '{"check":{"routes":["/a"]}}', 'write it as "GET /products"'],
    ["a route that is not a string", '{"check":{"routes":[4]}}', 'write it as "GET /products"'],
    ["a timeout of zero", '{"check":{"timeout":0}}', '"check.timeout" must be a number of seconds'],
    ["a timeout that is a string", '{"check":{"timeout":"9"}}', '"check.timeout" must be a number of seconds'],
  ])("refuses %s, and says where", (_what, text, reason) => {
    const parsed = parseConfig(text, "downtrace.json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("downtrace.json: ");
    expect(parsed.reason).toContain(reason);
  });
});

describe("link with a prepare that installs", () => {
  // `"link": true` links the working tree's node_modules into the base before prepare runs. An install in that
  // prepare writes through the links: pnpm installs the base's lockfile into the working tree's node_modules, and
  // the person's project is left with the dependencies of a commit they are not on.
  const refused = (prepare: string): string => {
    const parsed = parseConfig(JSON.stringify({ check: { prepare, link: true } }), "ci/check.json");
    expect(parsed.ok, prepare).toBe(false);
    return parsed.ok ? "" : parsed.reason;
  };

  it.each([
    "npm ci",
    "npm install",
    "npm i --no-audit",
    "pnpm install --frozen-lockfile",
    "pnpm i",
    "pnpm --filter api install",
    "pnpm -r install",
    "npm --prefix ../.. ci",
    "yarn",
    "yarn --frozen-lockfile",
    "yarn install --immutable",
    "bun install",
    "pnpm add left-pad",
    "npm rebuild",
    "pnpm run scss && pnpm install",
    "CI=1 pnpm install",
    "corepack pnpm install",
    "cd ../.. && yarn && yarn build",
    "(npm ci)",
    "pnpm install;pnpm build",
  ])("refuses %s, where it was written, and says what to do instead", (prepare) => {
    const reason = refused(prepare);
    expect(reason).toContain("ci/check.json: ");
    expect(reason).toContain('"check.link" is true and "check.prepare" installs');
    expect(reason).toContain("into the working tree's node_modules");
    expect(reason).toContain('Leave "link" out');
  });

  it("names the install it saw, out of a longer prepare", () => {
    expect(refused("pnpm run scss && pnpm --filter api install --offline && pnpm build")).toContain(
      "(pnpm --filter api install)",
    );
    expect(refused("cd ../.. && yarn && yarn build")).toContain("(yarn)");
  });

  it("refuses every verb that installs, with every package manager", () => {
    for (const manager of PACKAGE_MANAGERS) {
      for (const verb of INSTALLING_VERBS) {
        expect(installIn(`${manager} ${verb}`), `${manager} ${verb}`).toBe(`${manager} ${verb}`);
      }
    }
  });

  it.each([
    "npm run scss",
    "pnpm run build",
    "pnpm --filter api build",
    "yarn build",
    "yarn --silent build",
    "npm run install:hooks",
    "pnpm run install",
    "pnpm exec prisma generate",
    "node scripts/install.js",
    "npm run i18n",
    "make install",
    "pnpm build && cp -r dist ../",
  ])("takes %s, which installs nothing it can see", (prepare) => {
    expect(installIn(prepare)).toBeUndefined();
    expect(parseConfig(JSON.stringify({ check: { prepare, link: true } }), "x").ok).toBe(true);
  });

  it("takes an install in prepare when link is false or unsaid: nothing is linked, and it installs the base's own", () => {
    for (const link of [false, undefined]) {
      expect(parseConfig(JSON.stringify({ check: { prepare: "pnpm install", link } }), "x")).toMatchObject({
        ok: true,
        config: { prepare: "pnpm install", link },
      });
    }
  });
});

describe("a route as a project declares it", () => {
  it.each([
    ["GET /products", "GET /products"],
    ["get /products/:id", "GET /products/:id"],
    ["  POST   /checkout  ".replace(/ +/g, " ").trim(), "POST /checkout"],
  ])("%s is %s", (text, route) => {
    expect(declaredRoute(text)).toBe(route);
  });

  it.each(["/products", "GET", "GET products", "GET /a b", ""])("%j is not a route", (text) => {
    expect(declaredRoute(text)).toBeUndefined();
  });
});

describe("a command as a line a shell reads back the same", () => {
  // Asked of a real shell: the quoting is only right if `sh` hands back the words that went in.
  it.each([
    [["a b", "c"]],
    [["it's", 'say "hi"']],
    [["$HOME", "`date`", "$(date)"]],
    [["*", "?", "[x]", "~"]],
    [["", "-t", "x;y", "a&b", "c|d", "e>f"]],
    [["new\nline"]],
  ])("round-trips %j", async (words) => {
    const { stdout } = await run("sh", [
      "-c",
      `node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' ${shellJoin(words)}`,
    ]);
    expect(JSON.parse(stdout)).toEqual(words);
  });

  it("leaves a plain word as it is", () => {
    expect(shellJoin(["npm", "run", "test:unit", "--", "--reporter=dot"])).toBe("npm run test:unit -- --reporter=dot");
  });
});

describe("finding the configuration", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const tree = async (): Promise<string> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "downtrace-config-")));
    dirs.push(dir);
    await mkdir(join(dir, "packages", "api", "src"), { recursive: true });
    return dir;
  };

  it("looks up from where it is run, to the top of the repository", async () => {
    const root = await tree();
    await writeFile(join(root, CONFIG_FILE), '{"check":{"command":"from root"}}');
    const found = await findConfig(join(root, "packages", "api", "src"), root);
    expect(found?.path).toBe(join(root, CONFIG_FILE));
  });

  it("takes the nearest one", async () => {
    const root = await tree();
    await writeFile(join(root, CONFIG_FILE), "{}");
    await writeFile(join(root, "packages", "api", CONFIG_FILE), '{"check":{"command":"api"}}');
    const found = await findConfig(join(root, "packages", "api", "src"), root);
    expect(found?.path).toBe(join(root, "packages", "api", CONFIG_FILE));
  });

  it("does not look past the top of the repository: a file above it is somebody else's", async () => {
    const root = await tree();
    await writeFile(join(root, CONFIG_FILE), "{}");
    expect(await findConfig(join(root, "packages", "api"), join(root, "packages"))).toBeUndefined();
  });

  it("says when it cannot read one that is there, and does not take it for no file", async () => {
    const root = await tree();
    await mkdir(join(root, CONFIG_FILE));
    await expect(findConfig(root, root)).rejects.toThrow();
  });
});
