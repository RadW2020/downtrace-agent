const { Pool } = require("pg");

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54331/postgres";

function createPool() {
  return new Pool({ connectionString: url });
}

module.exports = { createPool };
