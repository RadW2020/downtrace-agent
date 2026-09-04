import type { Cache } from "./cache.ts";
import type { CountingClient, Db } from "./db.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import type { ProviderClient } from "./provider-client.ts";
import type { Regressions } from "./regressions.ts";
import type { RequestCounters } from "./stats.ts";

export interface CheckoutDeps {
  db: Db;
  cache: Cache;
  provider: ProviderClient;
  regressions: Regressions;
}

export interface CheckoutItem {
  productId: number;
  quantity: number;
}

export interface CheckoutInput {
  userId: number;
  items: CheckoutItem[];
  coupon?: string;
}

export interface CheckoutResult {
  orderId: number;
  totalCents: number;
  status: "paid";
}

/**
 * Normal profile (the reference every regression is measured against):
 * 12 SQL queries, 2 provider calls, 0 retries, 3 Redis operations.
 *
 * Provider calls happen inside the transaction on purpose: it is a common
 * real-world shape and it is what turns a slow dependency into pool pressure.
 */
export async function checkout(
  deps: CheckoutDeps,
  ctx: RequestCounters,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const { userId, items, coupon } = validate(input);
  const { db, cache, provider, regressions } = deps;

  const client = await db.connect(ctx);
  let leaked = false;
  try {
    await client.query("BEGIN"); // 1
    const user = await client.query<{ id: number }>("SELECT id FROM users WHERE id = $1", [userId]); // 2
    if (!user.rows[0]) throw new NotFoundError(`user ${userId} not found`);
    const discount = await client.query<{ percent_off: number }>("SELECT percent_off FROM coupons WHERE code = $1", [
      coupon ?? "WELCOME10",
    ]); // 3
    const percentOff = discount.rows[0]?.percent_off ?? 0;
    const order = await client.query<{ id: string }>(
      "INSERT INTO orders (user_id, total_cents, status) VALUES ($1, 0, 'pending') RETURNING id",
      [userId],
    ); // 4
    const orderId = Number(order.rows[0]?.id);

    const subtotal = regressions.isEnabled("n_plus_one")
      ? await addItemsOnePerLine(client, orderId, items) // 4 queries per line
      : await addItemsInBulk(client, orderId, items); // 5, 6, 7

    const total = Math.round((subtotal * (100 - percentOff)) / 100);
    await client.query("INSERT INTO payments (order_id, status) VALUES ($1, 'pending')", [orderId]); // 8

    const auth = await provider.call(ctx, "/authorize", { orderId, amountCents: total });
    const capture = await provider.call(ctx, "/capture", { orderId, ref: auth.ref });

    await client.query("UPDATE payments SET status = 'captured', provider_ref = $2 WHERE order_id = $1", [
      orderId,
      capture.ref,
    ]); // 9
    await client.query("UPDATE orders SET status = 'paid', total_cents = $2 WHERE id = $1", [orderId, total]); // 10
    await client.query("INSERT INTO order_events (order_id, type) VALUES ($1, 'paid')", [orderId]); // 11
    await client.query("COMMIT"); // 12

    await cache.incr(ctx, `orders:${userId}`);
    await cache.set(ctx, `lastorder:${userId}`, String(orderId), 3600);
    await cache.del(ctx, `cart:${userId}`);

    if (regressions.isEnabled("pool_leak") && Math.random() < regressions.params("pool_leak").rate) {
      leaked = true;
      db.leak(client);
    }
    return { orderId, totalCents: total, status: "paid" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (!leaked) client.release();
  }
}

/** One query for the products, one multi-row insert, one bulk stock update. */
async function addItemsInBulk(client: CountingClient, orderId: number, items: CheckoutItem[]): Promise<number> {
  const ids = items.map((i) => i.productId);
  const quantities = items.map((i) => i.quantity);
  const products = await client.query<{ id: number; price_cents: number; stock: number }>(
    "SELECT id, price_cents, stock FROM products WHERE id = ANY($1::int[]) FOR UPDATE",
    [ids],
  );
  const byId = new Map(products.rows.map((p) => [p.id, p]));

  let subtotal = 0;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product) throw new NotFoundError(`product ${item.productId} not found`);
    if (product.stock < item.quantity) throw new BadRequestError(`insufficient stock for product ${item.productId}`);
    subtotal += product.price_cents * item.quantity;
    const base = values.length;
    values.push(orderId, item.productId, item.quantity, product.price_cents);
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
  }
  await client.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ${tuples.join(", ")}`,
    values,
  );
  await client.query(
    "UPDATE products p SET stock = p.stock - u.qty FROM unnest($1::int[], $2::int[]) AS u(id, qty) WHERE p.id = u.id",
    [ids, quantities],
  );
  return subtotal;
}

/** The N+1 regression: four round trips per line instead of three for the whole order. */
async function addItemsOnePerLine(client: CountingClient, orderId: number, items: CheckoutItem[]): Promise<number> {
  let subtotal = 0;
  for (const item of items) {
    const product = await client.query<{ id: number; price_cents: number }>(
      "SELECT id, price_cents FROM products WHERE id = $1 FOR UPDATE",
      [item.productId],
    );
    if (!product.rows[0]) throw new NotFoundError(`product ${item.productId} not found`);
    const stock = await client.query<{ stock: number }>("SELECT stock FROM products WHERE id = $1", [item.productId]);
    if ((stock.rows[0]?.stock ?? 0) < item.quantity) {
      throw new BadRequestError(`insufficient stock for product ${item.productId}`);
    }
    await client.query(
      "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
      [orderId, item.productId, item.quantity, product.rows[0].price_cents],
    );
    await client.query("UPDATE products SET stock = stock - $2 WHERE id = $1", [item.productId, item.quantity]);
    subtotal += product.rows[0].price_cents * item.quantity;
  }
  return subtotal;
}

function validate(input: unknown): CheckoutInput {
  if (typeof input !== "object" || input === null) throw new BadRequestError("body must be an object");
  const { userId, items, coupon } = input as Record<string, unknown>;
  if (!Number.isInteger(userId)) throw new BadRequestError("userId must be an integer");
  if (!Array.isArray(items) || items.length === 0) throw new BadRequestError("items must be a non-empty array");
  const parsed: CheckoutItem[] = items.map((item, i) => {
    const { productId, quantity } = (item ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(productId)) throw new BadRequestError(`items[${i}].productId must be an integer`);
    if (!Number.isInteger(quantity) || (quantity as number) <= 0)
      throw new BadRequestError(`items[${i}].quantity must be a positive integer`);
    return { productId: productId as number, quantity: quantity as number };
  });
  if (coupon !== undefined && typeof coupon !== "string") throw new BadRequestError("coupon must be a string");
  return coupon === undefined
    ? { userId: userId as number, items: parsed }
    : { userId: userId as number, items: parsed, coupon };
}
