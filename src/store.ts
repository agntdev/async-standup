/**
 * Persistent domain-data store — Redis-backed durable storage for all domain
 * entities (Teams, Members, Standup Runs, Digests). Ephemeral conversation state
 * lives in the toolkit's session storage; this module is for data that MUST
 * survive a restart.
 *
 * Uses the toolkit's Redis session storage pattern but with a different key prefix
 * for domain data. Falls back to in-memory when REDIS_URL is not set (dev/test).
 *
 * CRITICAL: Never enumerate the keyspace (no KEYS/SCAN/readAll). All lookups use
 * explicit INDEX records (e.g. team's memberIds[]).
 */

import { createRequire } from "node:module";

// ── Key-value shape ──────────────────────────────────────────────────────────

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Set multiple keys atomically-ish (chained sets). */
  mset(...entries: [key: string, value: string][]): Promise<void>;
  /** Delete multiple keys. */
  mdel(...keys: string[]): Promise<void>;
}

// ── In-memory fallback ──────────────────────────────────────────────────────

class MemoryStore implements KvStore {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    const v = this.data.get(key);
    return v === undefined ? null : v;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async mset(...entries: [string, string][]): Promise<void> {
    for (const [k, v] of entries) {
      this.data.set(k, v);
    }
  }

  async mdel(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.data.delete(k);
    }
  }
}

// ── Redis-backed store ──────────────────────────────────────────────────────

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  exists(key: string): Promise<number>;
}

class RedisStore implements KvStore {
  constructor(
    private readonly client: RedisLike,
    private readonly prefix: string = "bot:",
  ) {}

  private k(key: string): string {
    return this.prefix + key;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key));
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(this.k(key), value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async has(key: string): Promise<boolean> {
    const r = await this.client.exists(this.k(key));
    return r === 1;
  }

  async mset(...entries: [string, string][]): Promise<void> {
    if (entries.length === 0) return;
    for (const [k, v] of entries) {
      await this.client.set(this.k(k), v);
    }
  }

  async mdel(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    for (const k of keys) {
      await this.client.del(this.k(k));
    }
  }
}

// ── Singleton store ─────────────────────────────────────────────────────────

let _store: KvStore | null = null;

/** Get the persistent domain-data store. Creates it on first call. */
export function getStore(): KvStore {
  if (_store) return _store;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const require = createRequire(import.meta.url);
    const ioredis: { default?: { new (url: string, opts?: object): RedisLike } } = require("ioredis");
    const Redis = ioredis.default ?? (ioredis as unknown as { new (url: string, opts?: object): RedisLike });
    const client = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    _store = new RedisStore(client as unknown as RedisLike);
  } else {
    _store = new MemoryStore();
  }
  return _store;
}

/** Reset the store (test-only). */
export function resetStore(): void {
  _store = null;
}

/** Override the store with a specific instance (test-only). */
export function setStore(s: KvStore): void {
  _store = s;
}