import { describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../src/check/args.ts";

describe("the command line of downtrace", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]], [["check", "--help"]]])("asks for the help with %j", (argv) => {
    expect(parseArgs(argv)).toEqual({ kind: "help" });
  });

  it("asks for the version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  it("reads a check with nothing else: the base is HEAD and the command comes from the configuration", () => {
    expect(parseArgs(["check"])).toEqual({
      kind: "check",
      base: undefined,
      json: false,
      config: undefined,
      timeoutSeconds: undefined,
      command: [],
    });
  });

  it("reads every option, spelled either way", () => {
    expect(parseArgs(["check", "--base", "origin/main", "--json", "--config=ci/dt.json", "--timeout", "30"])).toEqual({
      kind: "check",
      base: "origin/main",
      json: true,
      config: "ci/dt.json",
      timeoutSeconds: 30,
      command: [],
    });
    expect(parseArgs(["check", "--base=main"])).toMatchObject({ base: "main" });
  });

  it("takes everything after -- as the test command, flags included", () => {
    expect(parseArgs(["check", "--base", "main", "--", "npm", "test", "--", "--json", "--base", "x"])).toMatchObject({
      base: "main",
      json: false,
      command: ["npm", "test", "--", "--json", "--base", "x"],
    });
  });

  it.each([
    [["check", "--base"], "--base needs a value"],
    [["check", "--timeout", "soon"], "--timeout wants a number of seconds above zero"],
    [["check", "--timeout", "0"], "--timeout wants a number of seconds above zero"],
    [["check", "--frobnicate"], "unknown option --frobnicate"],
    [["check", "npm", "test"], 'unexpected "npm": the test command goes after --'],
    [["deploy"], 'unknown command "deploy": the ones there are are "check" and "init"'],
    [["init", "--frobnicate"], "unknown option --frobnicate for init"],
    [["init", "src"], 'unexpected "src": init looks at the directory it runs in'],
  ])("says what is wrong with %j", (argv, message) => {
    const parsed = parseArgs(argv);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" ? parsed.message : "").toContain(message);
  });

  it("reads init, with --json or without, and its help", () => {
    expect(parseArgs(["init"])).toEqual({ kind: "init", json: false });
    expect(parseArgs(["init", "--json"])).toEqual({ kind: "init", json: true });
    expect(parseArgs(["init", "--help"])).toEqual({ kind: "help" });
    expect(USAGE).toContain("downtrace init [--json]");
  });

  it("documents every option it reads", () => {
    for (const option of ["--base", "--json", "--config", "--timeout", "--help", "--version"]) {
      expect(USAGE).toContain(option);
    }
  });
});
