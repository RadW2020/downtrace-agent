import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54333/postgres";

export function createPool() {
  return new pg.Pool({ connectionString: url });
}
