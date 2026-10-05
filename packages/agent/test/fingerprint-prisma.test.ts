import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../src/fingerprint.ts";

/**
 * What Prisma writes, read by the normaliser (DT-92, invariant 5). The statements are what `pg` received from Prisma
 * 7.10.0 through `@prisma/adapter-pg`, captured against a Postgres 17 for one of each of the operations an application
 * runs: create with a nested create, `createMany`, a filter with `OR`, `in`, `contains` and `startsWith`, `findFirst`,
 * `update`, `updateMany`, `upsert`, `groupBy`, `aggregate`, a transaction, `deleteMany`, and the two raw forms. Prisma
 * sends the values as parameters (`$1`), and those travel beside the text and are never read here; what is asked
 * is what the text says — the names, the shapes, and the two places where a value can still be in it: a literal in raw
 * SQL the application wrote, and the literals Prisma writes itself (`LIKE ('%' || $1 || '%')`).
 */
const PRISMA_7 = [
  "BEGIN",
  'INSERT INTO "public"."User" ("email","name") VALUES ($1,$2) RETURNING "public"."User"."id"',
  'INSERT INTO "public"."Post" ("title","authorId") VALUES ($1,$2), ($3,$4)',
  'SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE "public"."User"."id" = $1 LIMIT $2 OFFSET $3',
  "COMMIT",
  'INSERT INTO "public"."User" ("email","name") VALUES ($1,$2), ($3,$4) ON CONFLICT DO NOTHING',
  'SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE ("public"."User"."name"::text LIKE (\'%\' || $1 || \'%\') OR "public"."User"."email" IN ($2,$3,$4)) ORDER BY "public"."User"."id" DESC LIMIT $5 OFFSET $6',
  'SELECT "public"."Post"."id", "public"."Post"."title", "public"."Post"."authorId" FROM "public"."Post" WHERE ("public"."Post"."title"::text LIKE ($1 || \'%\') AND "public"."Post"."authorId" IN ($2,$3,$4,$5,$6)) OFFSET $7',
  'SELECT "public"."User"."id", "public"."User"."email", "public"."User"."name" FROM "public"."User" WHERE "public"."User"."name" = $1 LIMIT $2 OFFSET $3',
  'UPDATE "public"."User" SET "name" = $1 WHERE ("public"."User"."id" = $2 AND 1=1) RETURNING "public"."User"."id", "public"."User"."email", "public"."User"."name"',
  'UPDATE "public"."User" SET "name" = $1 WHERE "public"."User"."name"::text LIKE ($2 || \'%\')',
  'INSERT INTO "public"."User" ("email","name") VALUES ($1,$2) ON CONFLICT ("email") DO UPDATE SET "name" = $3 WHERE ("public"."User"."email" = $4 AND 1=1) RETURNING "public"."User"."id", "public"."User"."email", "public"."User"."name"',
  'SELECT COUNT(*) AS "_count$_all", "public"."Post"."authorId" FROM "public"."Post" WHERE 1=1 GROUP BY "public"."Post"."authorId" HAVING "public"."Post"."authorId" > $1 OFFSET $2',
  'SELECT MAX("id") AS "_max$id", COUNT(*) AS "_count$_all" FROM (SELECT "public"."User"."id" FROM "public"."User" WHERE 1=1 OFFSET $1) AS "sub"',
  "SELECT id FROM \"User\" WHERE email = 'literal-secret@x.test' AND name = $1",
  'UPDATE "User" SET name = $1 WHERE id = $2',
  'DELETE FROM "public"."Post" WHERE "public"."Post"."authorId" = $1',
  'DELETE FROM "public"."User" WHERE ("public"."User"."id" = $1 AND 1=1) RETURNING "public"."User"."id", "public"."User"."email", "public"."User"."name"',
  'DELETE FROM "public"."User" WHERE "public"."User"."email"::text LIKE (\'%\' || $1 || \'%\')',
];

/** Every value the application passed in the run the statements were captured from, and the literal it wrote inline. */
const VALUES = [
  "secret-domain.test",
  "Ana Secreta",
  "Ana Renamed",
  "first secret post",
  "tpl-secret",
  "literal-secret",
];

describe("Prisma's SQL, as the normaliser reads it", () => {
  it.each(PRISMA_7)("%s: understood, with no parameter and no value left in the label", (sql) => {
    const { text, class: klass } = fingerprintOf(sql);
    expect(
      klass,
      "a statement Prisma writes is one the normaliser reads, and not one that travels as hash and class",
    ).toBeUndefined();
    expect(text).not.toMatch(/\$\d/);
    for (const value of VALUES) expect(text).not.toContain(value);
  });

  it("replaces the literal an application writes inline in raw SQL, which Prisma does not parameterise", () => {
    const raw = PRISMA_7.find((sql) => sql.includes("literal-secret"));
    expect(raw, "the corpus holds the raw statement").toBeDefined();
    expect(fingerprintOf(raw as string).text).toBe('SELECT id FROM "User" WHERE email = ? AND name = ?');
  });

  it("gives one label to the same statement whatever the number of values in a list", () => {
    const list = (n: number) =>
      `SELECT "public"."User"."id" FROM "public"."User" WHERE "public"."User"."email" IN (${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(",")}) LIMIT $${n + 1}`;
    const hashes = new Set([1, 2, 3, 17, 400].map((n) => fingerprintOf(list(n)).hash));
    expect(hashes.size, "a batch of different size is not a different statement").toBe(1);
  });

  // With tracing on, Prisma appends the trace's identity to every statement as a comment, which differs in each one:
  // 5.22.0 and 6.19.3 were seen to, with the `tracing` preview and with Prisma 6's helper. A fingerprint that kept it
  // would make every execution of a query a different query, and fill the profile with them.
  it.each([
    ["5.22.0 with the tracing preview", "/* traceparent='00-f5b660d96ecdb7815331a7fd69785708-1b5f7a62f420aa3e-01' */"],
    ["6.19.3 with a tracing helper", "/* traceparent='00-41ea41c82ca48c29d058c6d5471511ce-774be2c63a3534d9-01' */"],
  ])("ignores the trace comment of Prisma %s", (_version, comment) => {
    const bare = fingerprintOf(PRISMA_7[2] as string);
    const traced = fingerprintOf(`${PRISMA_7[2]} ${comment}`);
    expect(traced).toEqual(bare);
    expect(traced.text).not.toContain("traceparent");
  });
});
