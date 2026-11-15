import { hmacHex } from './crypto';
import { cleanCode } from './format';

export type Metric = 'visit' | 'checkout_start' | 'paid' | 'waitlist_join';

/** Aggregate first-party counters: (UTC day, metric, outreach code) → count. No personal data. */
export function countStatement(db: D1Database, metric: Metric, code: string, now: number): D1PreparedStatement {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  return db
    .prepare(
      `INSERT INTO daily_counts (day, metric, code, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, metric, code) DO UPDATE SET count = count + 1`,
    )
    .bind(day, metric, cleanCode(code));
}

export async function countMetric(db: D1Database, metric: Metric, code: string, now: number): Promise<void> {
  await countStatement(db, metric, code, now).run();
}

/**
 * Fixed-window rate limit backed by D1. The key is an HMAC of the client IP (never stored raw).
 * Returns true when the request is allowed.
 */
export async function rateLimit(
  db: D1Database,
  secret: string,
  ip: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: number,
): Promise<boolean> {
  const key = `${bucket}:${(await hmacHex(secret, `ip:${ip}`)).slice(0, 32)}`;
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, win, count) VALUES (?, ?, 1)
       ON CONFLICT(key, win) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}
