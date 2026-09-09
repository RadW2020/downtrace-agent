import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The admin surface is the contract between this app and the benchmark, and it is only written down in the
// README. Two routes lived there for months without being in it — `db/checkpoints`, which is how the bench finds
// out that Postgres decided to write for twenty-six seconds in the middle of a measurement, and `db/reset`, which
// is what makes two rounds comparable (gh-251).
//
// Reading the source rather than starting the app: this is about what is written down, not about what answers.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the admin surface", () => {
  it("is documented, route by route", () => {
    const source = read("../src/app.ts");
    const readme = read("../README.md");

    const paths = [...source.matchAll(/admin\.(?:get|post|put|delete)\("([^"]+)"/g)].map(
      ([, path]) => `/__admin${path}`,
    );
    expect(paths.length).toBeGreaterThan(0);

    // Exact strings, not `includes`: a README that mentions `/__admin/stats/reset` would otherwise be taken to
    // document `/__admin/stats` too, and the whole point is to notice what nobody wrote down.
    const documented = new Set([...readme.matchAll(/\/__admin[A-Za-z0-9/_-]*/g)].map(([path]) => path));
    const undocumented = [...new Set(paths)].filter((path) => !documented.has(path));
    expect(undocumented, "these admin routes are not in the README").toEqual([]);
  });
});
