/**
 * Private booking access. Bearer tokens (256-bit) are only ever stored as SHA-256 hashes.
 * A token arrives once via /b/<token> (or is minted at checkout start), is exchanged into an HttpOnly
 * cookie, and the URL is cleaned with a redirect. The public booking id alone grants nothing.
 */

import type { AppConfig } from './config';
import { hmacHex, looksLikeToken, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import type { BookingRow } from './db';
import { serializeCookie } from './http';

export const MAX_COOKIE_TOKENS = 8;
const COOKIE_MAX_AGE = 180 * 86_400;

export function accessCookieName(cfg: AppConfig): string {
  // __Host- requires Secure; plain http://localhost development uses an unprefixed name.
  return cfg.envName === 'development' ? 'kt_access' : '__Host-kt_access';
}

export function refCookieName(cfg: AppConfig): string {
  return cfg.envName === 'development' ? 'kt_ref' : '__Host-kt_ref';
}

export async function issueAccessToken(
  db: D1Database,
  bookingId: string,
  kind: 'device' | 'link',
  createdBy: string,
  now: number,
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare('INSERT INTO access_tokens (token_hash, booking_id, kind, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), bookingId, kind, now, createdBy)
    .run();
  return token;
}

export function readCookieTokens(cookies: Record<string, string>, cfg: AppConfig): string[] {
  const raw = cookies[accessCookieName(cfg)] ?? '';
  return raw
    .split('.')
    .filter((t) => looksLikeToken(t))
    .slice(0, MAX_COOKIE_TOKENS);
}

export function accessCookie(cfg: AppConfig, tokens: string[]): string {
  const unique = [...new Set(tokens)].slice(0, MAX_COOKIE_TOKENS);
  return serializeCookie(accessCookieName(cfg), unique.join('.'), {
    maxAge: unique.length ? COOKIE_MAX_AGE : 0,
    httpOnly: true,
    secure: cfg.envName !== 'development',
    sameSite: 'Lax',
  });
}

export interface AccessGrant {
  booking: BookingRow;
  tokenHash: string;
  token: string;
}

/** Bookings this device may open (token present in cookie, not revoked). */
export async function resolveAccess(db: D1Database, tokens: string[]): Promise<Map<string, AccessGrant>> {
  const grants = new Map<string, AccessGrant>();
  if (tokens.length === 0) return grants;
  const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
  const placeholders = hashes.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT t.token_hash AS token_hash, b.* FROM access_tokens t JOIN bookings b ON b.id = t.booking_id
       WHERE t.token_hash IN (${placeholders}) AND t.revoked_at IS NULL`,
    )
    .bind(...hashes)
    .all<BookingRow & { token_hash: string }>();
  for (const row of res.results) {
    const { token_hash, ...booking } = row;
    const token = tokens[hashes.indexOf(token_hash)]!;
    if (!grants.has(booking.id)) grants.set(booking.id, { booking: booking as BookingRow, tokenHash: token_hash, token });
  }
  return grants;
}

export async function lookupToken(
  db: D1Database,
  token: string,
): Promise<{ booking_id: string; kind: string; token_hash: string } | null> {
  if (!looksLikeToken(token)) return null;
  const hash = await sha256Hex(token);
  return db
    .prepare('SELECT booking_id, kind, token_hash FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(hash)
    .first();
}

export async function revokeAccessTokens(db: D1Database, bookingId: string, now: number, kind?: 'device' | 'link'): Promise<number> {
  const res = kind
    ? await db
        .prepare('UPDATE access_tokens SET revoked_at = ? WHERE booking_id = ? AND kind = ? AND revoked_at IS NULL')
        .bind(now, bookingId, kind)
        .run()
    : await db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE booking_id = ? AND revoked_at IS NULL').bind(now, bookingId).run();
  return res.meta.changes ?? 0;
}

/** Per-booking form token for cookie-authenticated POSTs (in addition to SameSite + Origin checks). */
export async function bookingFormToken(cfg: AppConfig, bookingId: string): Promise<string> {
  return (await hmacHex(cfg.appSecret, `booking-form:${bookingId}`)).slice(0, 32);
}

export async function checkBookingFormToken(cfg: AppConfig, bookingId: string, value: string | null): Promise<boolean> {
  if (!value) return false;
  return timingSafeEqual(value, await bookingFormToken(cfg, bookingId));
}

/** Signed attribution cookie value: which invite/share link a visitor arrived through. */
export async function signRef(cfg: AppConfig, inviteId: string): Promise<string> {
  return `${inviteId}.${(await hmacHex(cfg.appSecret, `ref:${inviteId}`)).slice(0, 24)}`;
}

export async function verifyRef(cfg: AppConfig, value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const id = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!/^inv_[a-z0-9]{8,32}$/.test(id)) return null;
  const expected = (await hmacHex(cfg.appSecret, `ref:${id}`)).slice(0, 24);
  return timingSafeEqual(sig, expected) ? id : null;
}
