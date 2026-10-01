import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.ts";

describe("configFromEnv: host", () => {
  it("listens only on the loopback unless told otherwise: /__admin switches regressions with no credential", () => {
    expect(configFromEnv({}).host).toBe("127.0.0.1");
    expect(configFromEnv({ HOST: "  " }).host).toBe("127.0.0.1");
  });

  it("listens where HOST says, for a deployment reached from another container (the canary's)", () => {
    expect(configFromEnv({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});

describe("configFromEnv: adminToken", () => {
  it("leaves /__admin open unless a token is set: the bench and a laptop need nothing", () => {
    expect(configFromEnv({}).adminToken).toBe("");
    expect(configFromEnv({ ADMIN_TOKEN: "   " }).adminToken).toBe("");
  });

  it("takes the token from ADMIN_TOKEN", () => {
    expect(configFromEnv({ ADMIN_TOKEN: " s3cret " }).adminToken).toBe("s3cret");
  });
});
