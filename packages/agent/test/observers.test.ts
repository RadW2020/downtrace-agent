import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";

const quiet: Logger = { warn: () => {}, debug: () => {} };

function config(instrument: string[]): AgentConfig {
  return {
    url: "http://sink.invalid",
    token: "t",
    environment: "test",
    version: "v",
    queryText: true,
    minimal: false,
    excludeEndpoints: [],
    excludeDependencies: [],
    inspect: undefined,
    debug: false,
    intervalMs: 60_000,
    instrument: new Set(instrument),
  } as AgentConfig;
}

/**
 * COB-01 by its name: «distingue instrumentación conectada de integración activa». Without this the cloud
 * cannot tell a service that does not use Redis from one that uses it and is not being watched — both look
 * like no rows at all (gh-180, invariant 14).
 */
describe("what the batch says it is observing", () => {
  it("says nothing until it has started, because it has not attached anything yet", () => {
    const agent = new Agent(config(["pg", "http", "redis", "runtime"]), { log: quiet });
    expect(agent.observers).toBeUndefined();
  });

  it("marks what was not asked for as off, which is not the same as not saying", () => {
    const agent = new Agent(config(["pg"]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toMatchObject({ http: "off", redis: "off", runtime: "off" });
    } finally {
      void agent.stop();
    }
  });

  it("says off for all four rather than going quiet when nothing is instrumented", () => {
    // `none` is an answer. Reporting it as absence would say «this sender did not tell us», which is what an
    // instrumentation older than 0.7.0 says, and the two must not read alike.
    const agent = new Agent(config([]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toEqual({ pg: "off", http: "off", redis: "off", runtime: "off" });
    } finally {
      void agent.stop();
    }
  });

  it("attaches the ones that subscribe to a channel, which cannot fail", () => {
    const agent = new Agent(config(["http", "redis", "runtime"]), { log: quiet });
    agent.start();
    try {
      expect(agent.observers).toMatchObject({ http: "on", redis: "on", runtime: "on" });
    } finally {
      void agent.stop();
    }
  });

  it("says unavailable when the driver was asked for and could not be attached to", () => {
    // The case that opened the ticket: a monorepo or a bundle where `pg` is not resolvable from the
    // application's root, or a `pg` whose shape is not the one being patched. Both come back from
    // `instrumentPg` as no version, and today both fail into a `log.debug` nobody sees while the cloud
    // publishes «this service calls no database».
    const agent = new Agent(config(["pg"]), { log: quiet, pgModule: { notAClient: true } });
    agent.start();
    try {
      expect(agent.observers?.pg).toBe("unavailable");
    } finally {
      void agent.stop();
    }
  });
});
