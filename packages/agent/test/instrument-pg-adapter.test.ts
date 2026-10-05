import Module from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { enterRequest } from "../src/context.ts";
import { armDriver } from "../src/instrument/arm.ts";
import { armPg } from "../src/instrument/pg.ts";
import type { Logger } from "../src/log.ts";
import { makeTree, type Tree, type TreeOptions } from "./support/prisma-layouts.ts";

/**
 * The `pg` that `@prisma/adapter-pg` uses (DT-92). Prisma 7 has no query engine of its own and goes to the database
 * through a driver adapter, and `@prisma/adapter-pg` is that adapter for Postgres: the queries are `pg`'s, and
 * nothing is asked of the application. Except that the adapter brings its own `pg` from 6.11 on, and the one it uses is
 * not always the one the application resolves — the lab found two layouts, measured with Prisma 7.10.0, where the
 * instrumentation patched the application's copy and the Prisma queries went through another (or the application
 * had none, and nothing was patched at all). The layouts are `test/support/prisma-layouts.ts`'s.
 *
 * What is asked here is the attach (ADR 0209): both copies are resolved without loading either, each is patched from
 * the start of the first request after its own load, and a query is counted once, by the copy that ran it.
 */

const handed: unknown[] = [];
const deps = {
  log: { warn: () => {}, debug: () => {} } as Logger,
  internalError: (err: unknown): void => {
    handed.push(err);
  },
};

const MARK = Symbol.for("downtrace.pg.instrumented");

/**
 * The runner puts the package store on `NODE_PATH`, so a `pg` resolves from anywhere in this process — the question
 * of an application that has none cannot be asked of it (`instrument-pg.test.ts` asks it of a process of its own).
 * Node reads the variable once at start, so it is read again here, empty: this file's process is its own, and the
 * runner starts one per file.
 */
beforeAll(() => {
  process.env.NODE_PATH = "";
  (Module as unknown as { _initPaths: () => void })._initPaths();
});

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.cleanup();
  expect(handed.splice(0), "the instrumentation failed while recording").toEqual([]);
});

async function tree(options: TreeOptions): Promise<Tree> {
  const made = await makeTree(options);
  trees.push(made);
  return made;
}

interface Driver {
  Client: new () => { query: (sql: string) => Promise<unknown> };
  Pool: { prototype: object };
}

/** What the application's own `require` gives for `pg`, or the adapter's copy through the adapter itself. */
const appPg = (t: Tree): Driver => t.appRequire("pg") as Driver;
const adapterPgOf = (t: Tree): Driver => {
  if (t.adapterPg === undefined) throw new Error("this layout has no copy of its own");
  return t.appRequire(t.adapterPg) as Driver;
};
const patched = (driver: Driver): boolean =>
  (driver.Client.prototype as unknown as Record<PropertyKey, unknown>)[MARK] === true;
const callsOf = (ctx: ReturnType<typeof enterRequest>): number =>
  ctx.work?.get("postgres\0db.internal:5432")?.calls ?? 0;

describe("the pg the Prisma adapter brings", () => {
  it("is patched when the application has no pg of its own — a pnpm layout, where the root holds only the adapter", async () => {
    const t = await tree({ adapter: "pnpm" });
    // The root has no `pg`: what the agent resolved before this was nothing, and the observer said unavailable.
    expect(() => t.appRequire.resolve("pg")).toThrow();

    const armed = armPg({ ...deps, from: t.from });
    expect(armed.state, "the adapter's copy is a driver to observe").toBe("on");
    expect(armed.attach(), "nothing is loaded yet: the attach waits").toBe(false);

    t.appRequire("@prisma/adapter-pg"); // the application loads the adapter, which loads its pg
    expect(armed.attach()).toBe(true);
    expect(patched(adapterPgOf(t)), "the copy the adapter loaded is the one patched").toBe(true);

    const ctx = enterRequest();
    await new (adapterPgOf(t).Client)().query("SELECT 1");
    expect(callsOf(ctx)).toBe(1);
  });

  it("is patched beside the application's own pg when the two are different modules — an npm layout, nested", async () => {
    const t = await tree({ app: "8.11.5", adapter: "nested", adapterVersion: "8.23.1" });
    expect(adapterPgOf(t), "two copies, two modules").not.toBe(appPg(t));

    const armed = armPg({ ...deps, from: t.from });
    expect(armed.state).toBe("on");
    expect(armed.attach()).toBe(true);
    expect(patched(appPg(t)), "the application's copy").toBe(true);
    expect(patched(adapterPgOf(t)), "the adapter's copy").toBe(true);

    // A query through each copy is counted once, not once per patch and not not at all.
    const ctx = enterRequest();
    await new (appPg(t).Client)().query("SELECT 1");
    expect(callsOf(ctx)).toBe(1);
    await new (adapterPgOf(t).Client)().query("SELECT 2");
    expect(callsOf(ctx)).toBe(2);
  });

  it("settles only when every copy that exists is patched, whichever the application loads last", async () => {
    const t = await tree({ app: "8.11.5", adapter: "nested" });
    const armed = armPg({ ...deps, from: t.from });
    appPg(t); // the application has loaded its own pg, and has not loaded the adapter yet
    expect(armed.attach(), "the adapter's copy is still to come").toBe(false);
    expect(patched(appPg(t)), "the copy that is there is patched at once").toBe(true);
    expect(patched(adapterPgOf(t)), "loading it here is the application's").toBe(false);
    expect(armed.attach()).toBe(true);
    expect(patched(adapterPgOf(t))).toBe(true);
    expect(armed.attach(), "settled: nothing more to patch").toBe(true);
  });

  it("is one patch, and one count, when the layout hoists both to the same module", async () => {
    const lines: string[] = [];
    const t = await tree({ app: "8.11.5", adapter: "hoisted" });
    const armed = armPg({ ...deps, log: { warn: () => {}, debug: (m: string) => lines.push(m) }, from: t.from });
    t.appRequire("@prisma/adapter-pg");
    expect(armed.attach()).toBe(true);
    expect(patched(appPg(t))).toBe(true);
    expect(
      lines.filter((l) => l.includes("instrumented pg")),
      "announced once",
    ).toHaveLength(1);

    const ctx = enterRequest();
    await new (appPg(t).Client)().query("SELECT 1");
    expect(callsOf(ctx), "counted once, not once for each of the ways it was found").toBe(1);
  });

  it("resolves without loading either copy, so the application's load is the first load", async () => {
    const t = await tree({ app: "8.11.5", adapter: "nested" });
    const armed = armPg({ ...deps, from: t.from });
    expect(armed.state).toBe("on");
    expect(t.appRequire.cache[t.appRequire.resolve("pg")], "the application's copy").toBeUndefined();
    expect(t.adapterPg && t.appRequire.cache[t.adapterPg], "the adapter's copy").toBeUndefined();
    expect(t.appRequire.cache[t.appRequire.resolve("@prisma/adapter-pg")], "nor the adapter").toBeUndefined();
  });

  it("says nothing new when there is no adapter: the application's pg alone, as before", async () => {
    const t = await tree({ app: "8.11.5" });
    const armed = armPg({ ...deps, from: t.from });
    expect(armed.state).toBe("on");
    expect(armed.attach()).toBe(false);
    appPg(t);
    expect(armed.attach()).toBe(true);
    expect(patched(appPg(t))).toBe(true);
  });

  it("says unavailable when neither the application nor the adapter has a pg that resolves", async () => {
    // The adapter is installed and its `pg` is not there — a broken install, or a layout this does not know.
    // Resolving it must not throw into the start, and the answer is the one there was before the adapter counted.
    const t = await tree({ adapter: "hoisted" });
    expect(() => t.appRequire.resolve("pg")).toThrow();
    const armed = armPg({ ...deps, from: t.from });
    expect(armed.state).toBe("unavailable");
    expect(armed.attach(), "nothing to wait for").toBe(true);
  });

  it("is still on, and still patches the application's copy, when the adapter's pg is not a driver", async () => {
    // The adapter's copy loads and is not the shape the patch needs: it is left alone, and it does not take the
    // application's copy down with it, nor throw into the request that asked for the attach.
    const t = await tree({ app: "8.11.5", adapter: "nested", adapterDriver: "module.exports = {};" });
    const armed = armPg({ ...deps, from: t.from });
    t.appRequire("@prisma/adapter-pg");
    appPg(t);
    expect(armed.attach(), "settled: there is nothing to patch in the adapter's copy").toBe(true);
    expect(patched(appPg(t))).toBe(true);
  });
});

/**
 * The mechanism under `armPg`, asked directly with a patch of its own: what each copy is patched with, how often, and
 * what one copy's failure leaves the others.
 */
describe("armDriver, beside the packages that bring their own copy", () => {
  /** Arms `pg` from the tree, and returns what the patch was called with, in order. */
  function armed(t: Tree, patch?: (module: unknown, version: string) => void) {
    const patched: Array<{ module: unknown; version: string }> = [];
    const result = armDriver<unknown>({
      driver: "pg",
      from: t.from,
      beside: ["@prisma/adapter-pg"],
      log: deps.log,
      internalError: deps.internalError,
      patch: (module, version) => {
        patched.push({ module, version });
        patch?.(module, version);
      },
    });
    return { ...result, patched };
  }

  it("patches each module once, with its own version, and a module found two ways once", async () => {
    const nested = await tree({ app: "8.11.5", adapter: "nested", adapterVersion: "8.23.1" });
    const two = armed(nested);
    appPg(nested);
    adapterPgOf(nested);
    expect(two.attach()).toBe(true);
    expect(two.attach(), "settled: nothing is patched again").toBe(true);
    expect(two.patched.map((p) => p.version).sort()).toEqual(["8.11.5", "8.23.1"]);

    const hoisted = await tree({ app: "8.11.5", adapter: "hoisted" });
    const one = armed(hoisted);
    appPg(hoisted);
    expect(one.attach()).toBe(true);
    expect(one.patched.map((p) => p.version)).toEqual(["8.11.5"]);
  });

  it("leaves the other copies attached when the patch of one throws, and counts the failure once", async () => {
    const t = await tree({ app: "8.11.5", adapter: "nested", adapterVersion: "8.23.1" });
    const boom = new Error("the patch of one copy failed");
    const a = armed(t, (_module, version) => {
      if (version === "8.11.5") throw boom;
    });
    appPg(t);
    adapterPgOf(t);
    // Never handed to the request that asked for it: the attach answers, and the failure is the agent's to count.
    expect(a.attach()).toBe(true);
    expect(a.patched.map((p) => p.version).sort(), "the other copy was still attached").toEqual(["8.11.5", "8.23.1"]);
    expect(handed.splice(0)).toEqual([boom]);
    expect(a.attach(), "and it is not attempted again").toBe(true);
    expect(a.patched).toHaveLength(2);
  });

  it("asks nothing of a package that is not installed", async () => {
    const t = await tree({ app: "8.11.5" });
    const a = armed(t);
    appPg(t);
    expect(a.attach()).toBe(true);
    expect(a.patched.map((p) => p.version)).toEqual(["8.11.5"]);
  });
});
