import { createHash, randomBytes } from 'node:crypto';

/** Insert a device access token for a booking directly (for states the UI can't reach, e.g. pending). */
export async function issueToken(db: D1Database, bookingId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await db
    .prepare(`INSERT INTO access_tokens (token_hash, booking_id, kind, created_at, created_by) VALUES (?, ?, 'device', ?, 'test')`)
    .bind(hash, bookingId, Math.floor(Date.now() / 1000))
    .run();
  return token;
}
