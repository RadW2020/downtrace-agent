import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type ConfigResult, configFromCode, configFromEnv, type InitOptions, SETTINGS } from "../src/config.ts";

/**
 * DT-133: the options `init()` takes, against the variables the environment gives. One list of the settings, and from
 * it both: code wins, the environment fills what the code leaves out, and an option means what its variable means
 * (RF-103). A DSN carries the URL and the token in one string, and is split when it is read (RF-104).
 */

const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

/** Every `DOWNTRACE_…` name a text mentions. */
const variablesIn = (text: string): string[] => [...new Set(text.match(/\bDOWNTRACE_[A-Z][A-Z0-9_]*/g) ?? [])];

/** The variables only `downtrace check` sets or reads: the command's plumbing, and no setting of the instrumentation. */
const isCheckOwn = (name: string): boolean => name.startsWith("DOWNTRACE_CHECK_");

const VARIABLES = new Set<string>(Object.values(SETTINGS).map((setting) => setting.variable));

/** A connection that reads, for the cases about something else. */
const CONNECTED = { DOWNTRACE_TOKEN: "dt_env", DOWNTRACE_URL: "https://env.example.com" };

const config = (result: ConfigResult) => {
  if (!result.ok) throw new Error(`expected a configuration, got: ${result.reason}`);
  return result.config;
};

/**
 * For each setting, two values of its kind as an option, and each as its variable's text: what the test of «the same
 * meaning» compares. Keyed by the option, and checked against `SETTINGS` below, so a setting added there without a
 * line here fails.
 */
const SAMPLES: { [K in keyof typeof SETTINGS]: [[InitOptions[K], string], [InitOptions[K], string]] } = {
  dsn: [
    ["https://dt_a@a.example.com", "https://dt_a@a.example.com"],
    ["https://dt_b@b.example.com/base/", "https://dt_b@b.example.com/base/"],
  ],
  token: [
    ["dt_a", "dt_a"],
    ["dt_b", "dt_b"],
  ],
  url: [
    ["https://a.example.com", "https://a.example.com"],
    ["http://b.example.com/", "http://b.example.com/"],
  ],
  env: [
    ["staging", "staging"],
    ["production", "production"],
  ],
  version: [
    ["v1", "v1"],
    ["8f71ac0", "8f71ac0"],
  ],
  debug: [
    [true, "1"],
    [false, "0"],
  ],
  intervalMs: [
    [2000, "2000"],
    [5000, "5000"],
  ],
  profileMs: [
    [20_000, "20000"],
    [40_000, "40000"],
  ],
  instrument: [
    [["pg", "http"], "pg,http"],
    ["none", "none"],
  ],
  minimal: [
    [true, "true"],
    [false, "0"],
  ],
  queryText: [
    [false, "off"],
    [true, "on"],
  ],
  excludeEndpoints: [
    [["/admin/*", "/health"], "/admin/*,/health"],
    ["/internal/*", "/internal/*"],
  ],
  excludeDependencies: [
    [["api.stripe.com"], "api.stripe.com"],
    ["metadata.internal", "metadata.internal"],
  ],
  inspect: [
    ["stderr", "stderr"],
    ["./batches.jsonl", "./batches.jsonl"],
  ],
  shed: [
    ["fine", "fine"],
    ["profile", "profile"],
  ],
  pgDepth: [
    ["context", "context"],
    ["wrapper", "wrapper"],
  ],
};

/** The rest of the environment a sample needs to connect: what the setting itself does not give. */
function around(option: keyof typeof SETTINGS): Record<string, string> {
  if (option === "dsn") return {};
  if (option === "token") return { DOWNTRACE_URL: CONNECTED.DOWNTRACE_URL };
  if (option === "url") return { DOWNTRACE_TOKEN: CONNECTED.DOWNTRACE_TOKEN };
  return CONNECTED;
}

/** What a configuration amounts to, apart from where the version was read, which `init()` names as itself. */
function aspect(result: ConfigResult): unknown {
  if (!result.ok) return { reason: result.reason };
  const { versionFrom: _from, ...rest } = result.config;
  return rest;
}

describe("one list of the settings, for options and variables alike (RF-103)", () => {
  // covers: RF-103
  it("lists as a setting every variable the configuration reads, apart from check's own", async () => {
    const source = await read("../src/config.ts");
    const read_ = variablesIn(source).filter((name) => !isCheckOwn(name));
    expect(read_.length).toBeGreaterThan(10);
    expect(read_.filter((name) => !VARIABLES.has(name))).toEqual([]);
  });

  // covers: RF-103
  it("has an option for every variable the README and the guide document", async () => {
    const pages = [
      "../README.md",
      ...(await readdir(new URL("../guide/", import.meta.url))).map((p) => `../guide/${p}`),
    ];
    const documented = new Set<string>();
    for (const page of pages) for (const name of variablesIn(await read(page))) documented.add(name);
    const settings = [...documented].filter((name) => !isCheckOwn(name));
    expect(settings).toContain("DOWNTRACE_DSN");
    expect(settings.filter((name) => !VARIABLES.has(name))).toEqual([]);
  });

  it("names each variable once", () => {
    expect(VARIABLES.size).toBe(Object.keys(SETTINGS).length);
  });

  it("has a sample for every setting, so the cases below cover them all", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(SETTINGS).sort());
  });

  // covers: RF-103
  it("gives an option the meaning of its variable, for every setting", () => {
    for (const option of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) {
      const { variable } = SETTINGS[option];
      for (const [value, text] of SAMPLES[option]) {
        const fromCode = configFromCode({ [option]: value }, around(option));
        const fromEnv = configFromEnv({ ...around(option), [variable]: text });
        expect(aspect(fromCode), `${option}: ${String(value)}`).toEqual(aspect(fromEnv));
      }
    }
  });

  // covers: RF-103
  it("lets the code win over the variable, for every setting", () => {
    for (const option of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) {
      const { variable } = SETTINGS[option];
      const [[mine, mineText], [, theirs]] = SAMPLES[option];
      const both = configFromCode({ [option]: mine }, { ...around(option), [variable]: theirs });
      const codeAlone = configFromEnv({ ...around(option), [variable]: mineText });
      expect(aspect(both), option).toEqual(aspect(codeAlone));
    }
  });

  // covers: RF-103
  it("fills an option left out from its variable, for every setting", () => {
    for (const option of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) {
      const { variable } = SETTINGS[option];
      const [, [, text]] = SAMPLES[option];
      const env = { ...around(option), [variable]: text };
      expect(aspect(configFromCode({}, env)), option).toEqual(aspect(configFromEnv(env)));
      expect(aspect(configFromCode(undefined, env)), option).toEqual(aspect(configFromEnv(env)));
      // An option given as undefined, or blank, is one left out: `init({ dsn: process.env.MISSING })`.
      const blank = SETTINGS[option].kind === "text" || SETTINGS[option].kind === "list" ? "" : undefined;
      expect(aspect(configFromCode({ [option]: blank }, env)), option).toEqual(aspect(configFromEnv(env)));
    }
  });

  // covers: RF-103
  it("applies the defaults with neither, and leaves the version to the chain that looks further", () => {
    const fromCode = config(configFromCode({ dsn: "https://dt_a@a.example.com" }, {}));
    const fromEnv = config(configFromEnv({ DOWNTRACE_TOKEN: "dt_a", DOWNTRACE_URL: "https://a.example.com" }));
    expect(fromCode).toEqual(fromEnv);
    expect(fromCode.version).toBe("unknown");
    expect(fromCode.versionFrom).toBeUndefined();
  });

  // covers: RF-103
  it("takes the environment from code over DOWNTRACE_ENV and NODE_ENV", () => {
    const env = { ...CONNECTED, DOWNTRACE_ENV: "staging", NODE_ENV: "development" };
    expect(config(configFromCode({ env: "production" }, env)).environment).toBe("production");
    expect(config(configFromCode({}, env)).environment).toBe("staging");
    expect(config(configFromCode({}, { ...CONNECTED, NODE_ENV: "development" })).environment).toBe("development");
  });

  // covers: RF-103
  it("takes the version from code over every variable of the chain, and says it came from init()", () => {
    const env = {
      ...CONNECTED,
      DOWNTRACE_VERSION: "v0",
      GITHUB_SHA: "abc123",
    };
    expect(config(configFromCode({ version: "v1" }, env))).toMatchObject({
      version: "v1",
      versionFrom: "init({ version })",
    });
    expect(config(configFromCode({}, env))).toMatchObject({ version: "v0", versionFrom: "DOWNTRACE_VERSION" });
    const { DOWNTRACE_VERSION: _v, ...platform } = env;
    expect(config(configFromCode({}, platform))).toMatchObject({ version: "abc123", versionFrom: "GITHUB_SHA" });
  });

  it("ignores an option of the wrong kind with a warning that names it and not its value, and the variable fills it", () => {
    const result = configFromCode(
      { debug: "yes", intervalMs: "2000" },
      { ...CONNECTED, DOWNTRACE_INTERVAL_MS: "3000" },
    );
    const { intervalMs, debug } = config(result);
    expect({ intervalMs, debug }).toEqual({ intervalMs: 3000, debug: false });
    expect(result.ok && result.warnings).toEqual([
      "init()'s debug must be true or false; it is ignored",
      "init()'s intervalMs must be a number; it is ignored",
    ]);
  });

  it("says which options it does not know, Sentry's names among them, and starts all the same", () => {
    const result = configFromCode({ environment: "staging", release: "v1" }, CONNECTED);
    expect(result.ok && result.warnings).toEqual([
      "init() has no option environment; it is ignored",
      "init() has no option release; it is ignored",
    ]);
  });

  it("refuses what is not an object of options, without starting", () => {
    for (const options of [null, "https://dt_a@a.example.com", 42, ["dsn"]]) {
      expect(configFromCode(options, CONNECTED), String(options)).toEqual({
        ok: false,
        reason: "init() takes an object of options",
      });
    }
  });
});

describe("a DSN (RF-104)", () => {
  // covers: RF-104
  it("is split into the URL and the token when it is read, in code or in DOWNTRACE_DSN", () => {
    for (const result of [
      configFromCode({ dsn: "https://dt_abc@downtrace.example.com" }, {}),
      configFromEnv({ DOWNTRACE_DSN: "https://dt_abc@downtrace.example.com" }),
      configFromEnv({ DOWNTRACE_DSN: "  https://dt_abc@downtrace.example.com/  " }),
    ]) {
      expect(config(result)).toMatchObject({ token: "dt_abc", url: "https://downtrace.example.com" });
    }
  });

  it("keeps a port and a path, and decodes a token written percent-encoded", () => {
    expect(config(configFromEnv({ DOWNTRACE_DSN: "http://dt_a%2Bb@127.0.0.1:8080/downtrace/" }))).toMatchObject({
      token: "dt_a+b",
      url: "http://127.0.0.1:8080/downtrace",
    });
  });

  // covers: RF-104
  it("never leaves the token in the URL", () => {
    const { url } = config(configFromCode({ dsn: "https://dt_secret@downtrace.example.com/x" }, {}));
    expect(url).not.toContain("dt_secret");
    expect(url).not.toContain("@");
    expect(() => new Request(`${url}/v0/aggregates`)).not.toThrow();
  });

  // covers: RF-104
  it("says what is wrong with a malformed one, without echoing the token, and stays inert", () => {
    const token = "dt_SECRETVALUE";
    const cases: Array<[string, RegExp]> = [
      [`${token}`, /^DOWNTRACE_DSN is not a URL/],
      [`https://${token}@`, /^DOWNTRACE_DSN is not a URL/],
      [`ftp://${token}@downtrace.example.com`, /^DOWNTRACE_DSN must start with http:\/\/ or https:\/\//],
      ["https://downtrace.example.com", /^DOWNTRACE_DSN carries no token/],
      [`https://${token}:pw@downtrace.example.com`, /^DOWNTRACE_DSN carries a password/],
      [`https://${token}@downtrace.example.com/?project=1`, /^DOWNTRACE_DSN carries a query or a fragment/],
      [`https://${token}@downtrace.example.com/#x`, /^DOWNTRACE_DSN carries a query or a fragment/],
      [`https://dt_%E0%A4%A@downtrace.example.com`, /^DOWNTRACE_DSN's token is not valid percent-encoding/],
    ];
    for (const [dsn, says] of cases) {
      const result = configFromEnv({ DOWNTRACE_DSN: dsn });
      expect(result.ok, dsn).toBe(false);
      const reason = result.ok ? "" : result.reason;
      expect(reason, dsn).toMatch(says);
      expect(reason, dsn).not.toContain("SECRETVALUE");
    }
    const fromCode = configFromCode({ dsn: `${token}` }, CONNECTED);
    expect(fromCode).toEqual({ ok: false, reason: expect.stringMatching(/^init\(\)'s dsn is not a URL/) });
  });

  // covers: RF-104
  it("refuses a DOWNTRACE_URL that carries the token, which fetch would refuse, without echoing it", () => {
    const result = configFromEnv({ DOWNTRACE_TOKEN: "dt_a", DOWNTRACE_URL: "https://dt_SECRETVALUE@x.example.com" });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^DOWNTRACE_URL carries credentials/) });
    expect(JSON.stringify(result)).not.toContain("SECRETVALUE");
  });

  it("refuses a dsn of the wrong kind rather than fall back to the environment", () => {
    expect(configFromCode({ dsn: 42 }, CONNECTED)).toEqual({ ok: false, reason: "init()'s dsn must be a string" });
  });

  // covers: RF-103, RF-104
  it("from code, wins over the environment's token and URL, and the environment's DSN", () => {
    const env = { ...CONNECTED, DOWNTRACE_DSN: "https://dt_envdsn@envdsn.example.com" };
    expect(config(configFromCode({ dsn: "https://dt_code@code.example.com" }, env))).toMatchObject({
      token: "dt_code",
      url: "https://code.example.com",
    });
    // A malformed DSN in the environment does not matter when the code connects on its own.
    expect(config(configFromCode({ dsn: "https://dt_code@code.example.com" }, { DOWNTRACE_DSN: "nope" })).token).toBe(
      "dt_code",
    );
  });

  // covers: RF-103, RF-104
  it("in the environment, gives the token or the URL the code left out", () => {
    const env = { DOWNTRACE_DSN: "https://dt_env@env.example.com" };
    expect(config(configFromCode({ token: "dt_code" }, env))).toMatchObject({
      token: "dt_code",
      url: "https://env.example.com",
    });
    expect(config(configFromCode({ url: "https://code.example.com" }, env))).toMatchObject({
      token: "dt_env",
      url: "https://code.example.com",
    });
  });

  it("wins, in the environment, over DOWNTRACE_TOKEN and DOWNTRACE_URL beside it", () => {
    const env = { ...CONNECTED, DOWNTRACE_DSN: "https://dt_dsn@dsn.example.com" };
    expect(config(configFromEnv(env))).toMatchObject({ token: "dt_dsn", url: "https://dsn.example.com" });
  });

  // covers: RF-104
  it("missing, with no token either, leaves the instrumentation off with one reason", () => {
    expect(configFromEnv({})).toEqual({
      ok: false,
      reason: "DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL",
    });
    expect(configFromCode({}, {})).toEqual({
      ok: false,
      reason: "init() was given no dsn, and DOWNTRACE_DSN is not set, nor DOWNTRACE_TOKEN and DOWNTRACE_URL",
    });
    expect(configFromCode({ url: "https://a.example.com" }, {})).toEqual({
      ok: false,
      reason: "init() was given no dsn or token, and DOWNTRACE_TOKEN is not set",
    });
    expect(configFromCode({ token: "dt_a" }, {})).toEqual({
      ok: false,
      reason: "init() was given no dsn or url, and DOWNTRACE_URL is not set",
    });
    expect(configFromCode({ token: "dt_a", url: "ftp://a.example.com" }, {})).toEqual({
      ok: false,
      reason: "init()'s url must start with http:// or https://",
    });
  });

  it("is not needed to inspect, as a token and a URL are not", () => {
    expect(config(configFromCode({ inspect: "stderr" }, {}))).toMatchObject({ token: "", url: "", inspect: "stderr" });
  });
});
