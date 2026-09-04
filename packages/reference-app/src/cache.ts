import { Redis } from "ioredis";
import type { RequestCounters } from "./stats.ts";

/** ioredis wrapper that counts operations per request. */
export class Cache {
  readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async get(ctx: RequestCounters, key: string): Promise<string | null> {
    ctx.redisOps += 1;
    return this.client.get(key);
  }

  async set(ctx: RequestCounters, key: string, value: string, ttlSeconds: number): Promise<void> {
    ctx.redisOps += 1;
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  async incr(ctx: RequestCounters, key: string): Promise<number> {
    ctx.redisOps += 1;
    return this.client.incr(key);
  }

  async del(ctx: RequestCounters, key: string): Promise<void> {
    ctx.redisOps += 1;
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
