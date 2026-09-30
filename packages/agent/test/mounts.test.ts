import { describe, expect, it } from "vitest";
import { armMountRecording, armMounts, mountPathOf } from "../src/mounts.ts";

/**
 * gh-903, the failure half of the criteria: the arming is best effort, and a failure to arm must cost the
 * `:param` fallback and nothing else — not a throw toward the application (invariant 2), which is what
 * `Agent.start()` relies on when it arms the record.
 */
describe("armMounts", () => {
  it("does not throw when express is not resolvable from the application", () => {
    // A base that resolves nothing: the application does not use express, or it is not reachable from it.
    expect(() => armMounts("/nonexistent/no-such-application-root-903/")).not.toThrow();
  });
});

describe("armMountRecording", () => {
  it("does not wrap a prototype whose use is not a function, and leaves it as it was", () => {
    const proto: Record<string, unknown> = { use: 42 };
    expect(armMountRecording(proto)).toBe(false);
    expect(proto).toEqual({ use: 42 });
  });

  it("refuses a prototype that is not an object or a function", () => {
    expect(armMountRecording(null)).toBe(false);
    expect(armMountRecording(undefined)).toBe(false);
    expect(armMountRecording("no")).toBe(false);
    expect(armMountRecording(7)).toBe(false);
  });

  it("records the mount path of the layers use adds, passes the call through, and arms once", () => {
    const original = function (this: { stack: unknown[] }, path: unknown, handler: unknown) {
      this.stack.push({ path, handler });
      return this;
    };
    const proto: Record<string, unknown> = { use: original };
    expect(armMountRecording(proto)).toBe(true);
    const wrapped = proto.use as typeof original;
    expect(wrapped).not.toBe(original);
    const router = { stack: [] as unknown[] };
    const middleware = (_req: unknown, _res: unknown): void => {};
    const returned = wrapped.call(router, "/tenants/:tenant", middleware);
    expect(returned).toBe(router);
    expect(router.stack).toHaveLength(1);
    expect(mountPathOf(router.stack[0] as object), "the layer keeps the path it was registered with").toBe(
      "/tenants/:tenant",
    );
    expect(armMountRecording(proto), "a second arm is a no-op").toBe(false);
    expect(proto.use).toBe(wrapped);
  });
});
