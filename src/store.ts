/**
 * Persistent key-value store for DURABLE domain data (teams, members, standup
 * runs, digests). Backed by Redis in production or an in-memory Map in
 * development / test. This is NOT session storage — it's for data that must
 * survive a restart.
 *
 * CRITICAL: never enumerate the keyspace (no KEYS, SCAN, readAllKeys). All
 * lookups go through explicit INDEX records maintained by the caller.
 */

import { createRequire } from "node:module";

/** A minimal async KV interface usable with both Redis and in-memory adapters. */
export interface PersistentKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  incr(key: string): Promise<number>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  lpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lrem(key: string, count: number, value: string): Promise<number>;
  llen(key: string): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hlen(key: string): Promise<number>;
}

// ── In-memory fallback (dev/test) ───────────────────────────────────────

class MemoryKV implements PersistentKV {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();
  private ttls = new Map<string, number>();

  private expireCheck(key: string): void {
    const exp = this.ttls.get(key);
    if (exp && Date.now() > exp) {
      this.store.delete(key);
      this.lists.delete(key);
      this.hashes.delete(key);
      this.ttls.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    this.expireCheck(key);
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.ttls.delete(key);
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.lists.delete(key);
    this.hashes.delete(key);
    this.ttls.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    this.expireCheck(key);
    return this.store.has(key) || this.lists.has(key) || this.hashes.has(key);
  }

  async incr(key: string): Promise<number> {
    this.expireCheck(key);
    const v = Number(this.store.get(key) ?? "0") + 1;
    this.store.set(key, String(v));
    return v;
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, Date.now() + seconds * 1000);
  }

  private ensureList(key: string): string[] {
    let list = this.lists.get(key);
    if (!list) { list = []; this.lists.set(key, list); }
    return list;
  }

  async lpush(key: string, value: string): Promise<number> {
    this.expireCheck(key);
    const list = this.ensureList(key);
    list.unshift(value);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.expireCheck(key);
    const list = this.ensureList(key);
    const s = start < 0 ? Math.max(0, list.length + start) : start;
    const e = stop < 0 ? list.length + stop : stop;
    return list.slice(s, e + 1);
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    this.expireCheck(key);
    const list = this.ensureList(key);
    let removed = 0;
    if (count > 0) {
      for (let i = 0; i < list.length && removed < count; i++) {
        if (list[i] === value) { list.splice(i, 1); removed++; i--; }
      }
    } else if (count < 0) {
      for (let i = list.length - 1; i >= 0 && removed < -count; i--) {
        if (list[i] === value) { list.splice(i, 1); removed++; }
      }
    } else {
      const filtered = list.filter((v) => v !== value);
      removed = list.length - filtered.length;
      list.length = 0; list.push(...filtered);
    }
    return removed;
  }

  async llen(key: string): Promise<number> {
    this.expireCheck(key);
    return this.ensureList(key).length;
  }

  private ensureHash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) { hash = new Map(); this.hashes.set(key, hash); }
    return hash;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.expireCheck(key);
    return this.ensureHash(key).get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this.ttls.delete(key);
    this.ensureHash(key).set(field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    this.ensureHash(key).delete(field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.expireCheck(key);
    const result: Record<string, string> = {};
    for (const [k, v] of this.ensureHash(key)) result[k] = v;
    return result;
  }

  async hlen(key: string): Promise<number> {
    this.expireCheck(key);
    return this.ensureHash(key).size;
  }
}

// ── Redis-backed adapter ────────────────────────────────────────────────

class RedisKV implements PersistentKV {
  constructor(private client: { call: (cmd: string, ...args: unknown[]) => Promise<unknown> }) {}

  async get(key: string): Promise<string | null> {
    return (await this.client.call("GET", key)) as string | null;
  }
  async set(key: string, value: string): Promise<void> {
    await this.client.call("SET", key, value);
  }
  async del(key: string): Promise<void> {
    await this.client.call("DEL", key);
  }
  async exists(key: string): Promise<boolean> {
    return ((await this.client.call("EXISTS", key)) as number) > 0;
  }
  async incr(key: string): Promise<number> {
    return (await this.client.call("INCR", key)) as number;
  }
  async setex(key: string, seconds: number, value: string): Promise<void> {
    await this.client.call("SETEX", key, String(seconds), value);
  }
  async lpush(key: string, value: string): Promise<number> {
    return (await this.client.call("LPUSH", key, value)) as number;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return (await this.client.call("LRANGE", key, String(start), String(stop))) as string[];
  }
  async lrem(key: string, count: number, value: string): Promise<number> {
    return (await this.client.call("LREM", key, String(count), value)) as number;
  }
  async llen(key: string): Promise<number> {
    return (await this.client.call("LLEN", key)) as number;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return (await this.client.call("HGET", key, field)) as string | null;
  }
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.call("HSET", key, field, value);
  }
  async hdel(key: string, field: string): Promise<void> {
    await this.client.call("HDEL", key, field);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const result = await this.client.call("HGETALL", key);
    const arr = result as string[];
    const out: Record<string, string> = {};
    for (let i = 0; i < arr.length; i += 2) out[arr[i]!] = arr[i + 1]!;
    return out;
  }
  async hlen(key: string): Promise<number> {
    return (await this.client.call("HLEN", key)) as number;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

let _kv: PersistentKV | null = null;

/** Get the persistent KV store. Uses Redis if REDIS_URL is set, otherwise in-memory. */
export function getKV(): PersistentKV {
  if (_kv) return _kv;

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis: any = req("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    const client = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    _kv = new RedisKV(client);
    return _kv;
  }

  _kv = new MemoryKV();
  return _kv;
}

// ── Test hooks ──────────────────────────────────────────────────────────

/** Inject a KV store. Test-only hook. */
export function setKV(kv: PersistentKV): void {
  _kv = kv;
}

/** Reset the KV store (back to lazy init). Test-only hook. */
export function resetKV(): void {
  _kv = null;
}

/** Get a fresh in-memory KV for testing. */
export function newMemoryKV(): PersistentKV {
  return new MemoryKV();
}
