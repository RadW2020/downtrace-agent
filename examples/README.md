# Examples

> Your coding agent just introduced an N+1. `downtrace check` catches it before you push.

One minimal application per supported combination. Each has a test suite that runs against Postgres, and a patch with the change a coding agent might make: a query per post where one query did.

| Directory | Framework | Database | Tests |
|---|---|---|---|
| [`express-pg-jest`](express-pg-jest) | Express 5 | `pg` | Jest |
| [`nestjs-prisma-jest`](nestjs-prisma-jest) | NestJS 12 on Express | Prisma 7 | Jest |
| [`fastify-pg-vitest`](fastify-pg-vitest) | Fastify 5 | `pg` | Vitest |

```sh
cd examples/express-pg-jest
npm install
npm run db            # Postgres, in Docker
npx downtrace init
npx downtrace check   # exit 0: no route got worse
npm run n-plus-one    # applies n-plus-one.patch
npx downtrace check   # exit 1: GET /posts runs a query per post
```

```
Worse (1)
  GET /posts   1 request in the base, 1 in the change
    appeared   select name from authors where id = ?  0 -> 5 per request
               ran at src/app.js:9
```

`check` compares your working tree against `HEAD`, so the patch needs no commit. `docker compose down` removes the database.
