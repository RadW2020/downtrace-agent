import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

/**
 * `server.json` is what the MCP Registry lists, and the registry takes it only if the npm version it names carries
 * the same name in its `mcpName`: a name that differs, or a version that is not the one published, and the listing
 * is refused at the publish — in the mirror, after npm has the package, where nobody is looking. Its versions are
 * written by `scripts/sync-mcp-version.sh` with the versions PR; this holds the three numbers together.
 */
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as {
  name: string;
  description: string;
  version: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }>;
  }>;
};

describe("the MCP Registry's server.json", () => {
  it("is named as the package says, under the GitHub account that publishes it", () => {
    expect(server.name).toBe((manifest as { mcpName?: string }).mcpName);
    // The registry checks the prefix against the GitHub login, as written: case and all.
    expect(server.name).toMatch(/^io\.github\.RadW2020\/[a-zA-Z0-9._-]+$/);
  });

  it("lists the version npm has, of this package, started over stdio", () => {
    expect(server.version).toBe(manifest.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: manifest.name,
      version: manifest.version,
      transport: { type: "stdio" },
    });
  });

  it("says in a hundred characters what it is, as the registry asks", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("asks for the variables the README says the server reads, the credential as a secret", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const variables = server.packages[0]?.environmentVariables ?? [];
    expect(variables.map((v) => v.name)).toEqual(["DOWNTRACE_URL", "DOWNTRACE_TOKEN"]);
    for (const { name } of variables) expect(readme).toContain(`\`${name}\``);
    expect(variables.find((v) => v.name === "DOWNTRACE_URL")?.isRequired).toBe(true);
    expect(variables.find((v) => v.name === "DOWNTRACE_TOKEN")).toMatchObject({ isRequired: false, isSecret: true });
  });
});
