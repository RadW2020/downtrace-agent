import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.ts";

describe("configFromEnv: host", () => {
  it("listens only on the loopback unless told otherwise: /__admin switches regressions with no credential", () => {
    expect(configFromEnv({}).host).toBe("127.0.0.1");
    expect(configFromEnv({ HOST: "  " }).host).toBe("127.0.0.1");
  });

  it("listens where HOST says, for a deployment whose network is already private (the canary's)", () => {
    expect(configFromEnv({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});
