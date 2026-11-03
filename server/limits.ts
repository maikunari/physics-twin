/**
 * In-memory response cache and rate limits for the thin server. They live in
 * the process: one dev server, or one warm Vercel function instance, so a
 * cold start empties them and two instances do not share them. That is
 * enough to stop a page in a loop or a curious visitor from spending the
 * hackathon credits; it is not a quota system.
 */

export type Clock = () => number;

/** Least-recently-used cache with a time to live. */
export class ReplyCache<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: Clock;

  constructor(maxEntries: number, ttlMs: number, now: Clock = Date.now) {
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expires <= this.#now()) return undefined;
    // Re-inserted, so the Map's insertion order is least recently used first.
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface Taken {
  readonly ok: boolean;
  /** When the caller may try again, s; 0 when `ok`. */
  readonly retryAfterSec: number;
}

/** At most `limit` calls per key in each fixed window. */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: Clock;

  constructor(limit: number, windowMs: number, now: Clock = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  take(key: string): Taken {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
      this.#sweep(now);
    }
    if (window.count >= this.#limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((window.start + this.#windowMs - now) / 1000)) };
    }
    window.count++;
    return { ok: true, retryAfterSec: 0 };
  }

  /** Drops finished windows so the map does not grow with every address ever seen. */
  #sweep(now: number) {
    if (this.#windows.size < 1024) return;
    for (const [key, w] of this.#windows) if (now - w.start >= this.#windowMs) this.#windows.delete(key);
  }
}

/** A cap on calls that reach the Meta Model API per UTC day, for every caller together (build plan: "daily cap env"). */
export class DailyCap {
  #day = '';
  #count = 0;
  readonly #limit: number;
  readonly #now: Clock;

  constructor(limit: number, now: Clock = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  take(): Taken {
    const now = this.#now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#count = 0;
    }
    if (this.#count >= this.#limit) {
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((midnight - now) / 1000)) };
    }
    this.#count++;
    return { ok: true, retryAfterSec: 0 };
  }
}
