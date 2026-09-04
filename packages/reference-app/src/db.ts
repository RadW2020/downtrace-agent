import pg from "pg";
import { PoolTimeoutError } from "./errors.ts";
import type { RequestCounters } from "./stats.ts";

export interface DbOptions {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
}

/** pg.Pool wrapper that counts queries and pool wait per request and supports deliberate leaks. */
export class Db {
  readonly pool: pg.Pool;
  private readonly leaked = new Set<pg.PoolClient>();

  constructor(options: DbOptions) {
    this.pool = new pg.Pool(options);
    // Idle clients can error (e.g. server restart); without a listener that would crash the process.
    this.pool.on("error", () => {});
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    ctx: RequestCounters | null,
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    if (ctx) ctx.sqlQueries += 1;
    return this.pool.query<R>(text, values);
  }

  /** Checks out a client, attributing the wait to the request. */
  async connect(ctx: RequestCounters): Promise<CountingClient> {
    const start = performance.now();
    try {
      const client = await this.pool.connect();
      return new CountingClient(client, ctx);
    } catch (err) {
      if (err instanceof Error && /timeout exceeded/i.test(err.message)) throw new PoolTimeoutError(err);
      throw err;
    } finally {
      ctx.poolWaitMs += performance.now() - start;
    }
  }

  /** Marks a client as intentionally never released (the `pool_leak` regression). */
  leak(client: CountingClient): void {
    this.leaked.add(client.raw);
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA);
    await this.pool.query(SEED);
  }

  async close(): Promise<void> {
    for (const client of this.leaked) client.release(true);
    this.leaked.clear();
    await this.pool.end();
  }
}

export class CountingClient {
  readonly raw: pg.PoolClient;
  private readonly ctx: RequestCounters;

  constructor(raw: pg.PoolClient, ctx: RequestCounters) {
    this.raw = raw;
    this.ctx = ctx;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    this.ctx.sqlQueries += 1;
    return this.raw.query<R>(text, values);
  }

  release(): void {
    this.raw.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id int PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id int PRIMARY KEY,
  name text NOT NULL,
  price_cents int NOT NULL,
  stock int NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
  code text PRIMARY KEY,
  percent_off int NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  total_cents int NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  product_id int NOT NULL REFERENCES products(id),
  quantity int NOT NULL,
  unit_price_cents int NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  provider_ref text,
  status text NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

const SEED = `
INSERT INTO users (id, email, name)
  SELECT i, 'user' || i || '@example.com', 'User ' || i FROM generate_series(1, 5) AS i
  ON CONFLICT DO NOTHING;
INSERT INTO products (id, name, price_cents, stock)
  SELECT i, 'Product ' || i, i * 100 + 99, 1000000 FROM generate_series(1, 50) AS i
  ON CONFLICT DO NOTHING;
INSERT INTO coupons (code, percent_off) VALUES ('WELCOME10', 10)
  ON CONFLICT DO NOTHING;
`;
