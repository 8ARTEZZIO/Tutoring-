/**
 * JSON API for the iPhone companion app (v1).
 *
 * - The app never sells anything (App Store guideline 3.1.3(d): group classes sold in an app must use
 *   in-app purchase), so this API only reads and manages existing bookings.
 * - Credentials are booking access tokens sent in JSON bodies (never in URLs, so never in logs). A private
 *   link (`/b/<token>`) is exchanged once for a separate device token that the app keeps in the Keychain;
 *   removing the booking from the app revokes only that device token.
 * - No cookies are read or set, so cross-site request forgery does not apply; no CORS headers are sent.
 */

import { issueAccessToken, lookupToken } from '../shared/access';
import { looksLikeToken, sha256Hex } from '../shared/crypto';
import { type BookingRow, type LessonRow, type ListingRow, getAllLessons, getBooking, getListing } from '../shared/db';
import { cleanText, isHttpsUrl } from '../shared/format';
import { jsonResponse, log } from '../shared/http';
import { rateLimit } from '../shared/metrics';
import { slotParts } from '../shared/ui/public';
import type { Ctx } from './context';

export const API_VERSION = 1;
const MAX_BODY = 8 * 1024;
const MAX_TOKENS = 20;
const TOKEN_LENGTH = 43;

export type AppBookingStatus = 'confirmed' | 'pending' | 'review' | 'cancelled' | 'not_booked';

export interface AppSession {
  uid: string;
  sequence: number;
  /** 1-based position among sessions that are still on; null for a cancelled session. */
  number: number | null;
  of: number;
  startsAt: number;
  endsAt: number;
  cancelled: boolean;
  meetingUrl: string | null;
  ukDate: string;
  ukTime: string;
}

export interface AppBooking {
  id: string;
  status: AppBookingStatus;
  title: string;
  topic: string;
  firstName: string;
  groupCancelled: boolean;
  cancelReason: string | null;
  sessions: AppSession[];
  canRequestCancellation: boolean;
  cancelRequestedAt: number | null;
  bookingPageUrl: string;
  updatedAt: number;
}

function apiError(status: number, error: string, message: string): Response {
  return jsonResponse({ error, message }, status, { 'X-Robots-Tag': 'noindex' });
}

function apiOk(body: unknown): Response {
  return jsonResponse(body, 200, { 'X-Robots-Tag': 'noindex' });
}

/** Find a private-link token in pasted text: a full /b/<token> link (any host) or the bare token. */
export function extractToken(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const text = input.trim();
  const inLink = /\/b\/([A-Za-z0-9_-]{43})(?=$|[/?#\s"'<>),.;])/.exec(text);
  if (inLink) return inLink[1]!;
  return /^[A-Za-z0-9_-]{43}$/.test(text) ? text : null;
}

async function readJson(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  const type = ctx.req.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return apiError(415, 'unsupported_media_type', 'Send JSON.');
  const declared = Number(ctx.req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY) return apiError(413, 'too_large', 'Request too large.');
  const text = await ctx.req.text();
  if (text.length > MAX_BODY) return apiError(413, 'too_large', 'Request too large.');
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return apiError(400, 'invalid_json', 'Expected a JSON object.');
    return value as Record<string, unknown>;
  } catch {
    return apiError(400, 'invalid_json', 'Malformed JSON.');
  }
}

function appStatus(b: BookingRow, listing: ListingRow): AppBookingStatus {
  if (listing.status === 'cancelled' && (b.status === 'confirmed' || b.status === 'cancelled')) return 'cancelled';
  switch (b.status) {
    case 'confirmed':
      return 'confirmed';
    case 'hold':
    case 'pending':
      return 'pending';
    case 'exception':
      return 'review';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'not_booked';
  }
}

export function toAppBooking(origin: string, now: number, b: BookingRow, listing: ListingRow, lessons: LessonRow[]): AppBooking {
  const groupCancelled = listing.status === 'cancelled';
  const status = appStatus(b, listing);
  const showLinks = status === 'confirmed';
  const sorted = [...lessons].sort((x, y) => x.starts_at - y.starts_at || x.id.localeCompare(y.id));
  const scheduled = sorted.filter((l) => l.status === 'scheduled');
  const sessions: AppSession[] = sorted.map((l) => {
    const index = scheduled.findIndex((s) => s.id === l.id);
    const cancelled = l.status === 'cancelled' || groupCancelled || b.status === 'cancelled';
    const parts = slotParts(l);
    return {
      uid: l.uid,
      sequence: l.revision,
      number: index >= 0 ? index + 1 : null,
      of: scheduled.length,
      startsAt: l.starts_at,
      endsAt: l.ends_at,
      cancelled,
      meetingUrl: showLinks && !cancelled && l.meeting_url && isHttpsUrl(l.meeting_url) ? l.meeting_url : null,
      ukDate: parts.date,
      ukTime: parts.time,
    };
  });
  const updatedAt = Math.max(b.updated_at, listing.updated_at, ...lessons.map((l) => l.updated_at));
  return {
    id: b.id,
    status,
    title: listing.title,
    topic: listing.topic,
    firstName: b.first_name,
    groupCancelled,
    cancelReason: groupCancelled ? listing.cancel_reason : null,
    sessions,
    canRequestCancellation: status === 'confirmed' && !b.cancel_requested_at && scheduled.some((l) => l.ends_at > now),
    cancelRequestedAt: b.cancel_requested_at,
    bookingPageUrl: `${origin}/booking/${b.id}`,
    updatedAt,
  };
}

async function appBooking(ctx: Ctx, b: BookingRow): Promise<AppBooking | null> {
  const listing = await getListing(ctx.db, b.listing_id);
  if (!listing) return null;
  return toAppBooking(ctx.cfg.publicOrigin, ctx.now, b, listing, await getAllLessons(ctx.db, listing.id));
}

/** Active (non-revoked) tokens → booking rows, keyed by token hash. */
async function bookingsByTokenHash(ctx: Ctx, hashes: string[]): Promise<Map<string, BookingRow>> {
  const map = new Map<string, BookingRow>();
  if (hashes.length === 0) return map;
  const res = await ctx.db
    .prepare(
      `SELECT t.token_hash AS token_hash, b.* FROM access_tokens t JOIN bookings b ON b.id = t.booking_id
       WHERE t.token_hash IN (${hashes.map(() => '?').join(',')}) AND t.revoked_at IS NULL`,
    )
    .bind(...hashes)
    .all<BookingRow & { token_hash: string }>();
  for (const row of res.results) {
    const { token_hash, ...booking } = row;
    map.set(token_hash, booking as BookingRow);
  }
  return map;
}

async function bookingForToken(ctx: Ctx, token: unknown): Promise<{ booking: BookingRow; hash: string } | null> {
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH || !looksLikeToken(token)) return null;
  const hash = await sha256Hex(token);
  const booking = (await bookingsByTokenHash(ctx, [hash])).get(hash);
  return booking ? { booking, hash } : null;
}

/** POST /api/app/v1/link {link} → exchange a private link for a device token. */
export async function apiLink(ctx: Ctx): Promise<Response> {
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'app-link', 20, 600, ctx.now))) {
    return apiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes.');
  }
  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const token = extractToken(body.link);
  if (!token) return apiError(400, 'not_a_link', "That doesn't look like a private booking link.");
  const row = await lookupToken(ctx.db, token);
  const booking = row ? await getBooking(ctx.db, row.booking_id) : null;
  if (!row || !booking) return apiError(404, 'link_not_valid', "This link isn't valid any more. Ask for a new private link.");
  const dto = await appBooking(ctx, booking);
  if (!dto) return apiError(404, 'link_not_valid', "This link isn't valid any more.");
  const deviceToken = await issueAccessToken(ctx.db, booking.id, 'device', 'ios-app', ctx.now);
  await ctx.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?').bind(ctx.now, row.token_hash).run();
  log('info', 'app_link_added', { booking: booking.id });
  return apiOk({ token: deviceToken, booking: dto });
}

/** POST /api/app/v1/bookings {tokens: [...]} → current state of every booking on the device. */
export async function apiBookings(ctx: Ctx): Promise<Response> {
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'app-sync', 120, 600, ctx.now))) {
    return apiError(429, 'rate_limited', 'Too many refreshes. Please wait a few minutes.');
  }
  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const tokens = body.tokens;
  if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS) {
    return apiError(400, 'invalid_tokens', `Send between 0 and ${MAX_TOKENS} tokens.`);
  }
  const valid = tokens.map((t) => typeof t === 'string' && t.length === TOKEN_LENGTH && looksLikeToken(t));
  const hashes = await Promise.all(tokens.map((t, i) => (valid[i] ? sha256Hex(t as string) : Promise.resolve(''))));
  const found = await bookingsByTokenHash(ctx, [...new Set(hashes.filter(Boolean))]);
  const results = [];
  for (const [i, hash] of hashes.entries()) {
    if (!valid[i]) {
      results.push({ ok: false, error: 'invalid' });
      continue;
    }
    const booking = found.get(hash);
    const dto = booking ? await appBooking(ctx, booking) : null;
    results.push(dto ? { ok: true, booking: dto } : { ok: false, error: 'revoked' });
  }
  return apiOk({ results, serverTime: ctx.now });
}

/** POST /api/app/v1/cancel-request {token, note} */
export async function apiCancelRequest(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const found = await bookingForToken(ctx, body.token);
  if (!found) return apiError(404, 'not_found', 'This booking is no longer available on this device.');
  const listing = await getListing(ctx.db, found.booking.listing_id);
  if (found.booking.status !== 'confirmed' || !listing || listing.status === 'cancelled') {
    return apiError(409, 'not_cancellable', 'Only confirmed bookings can be cancelled from the app.');
  }
  const note = typeof body.note === 'string' ? cleanText(body.note, 1000) : '';
  await ctx.db
    .prepare(
      `UPDATE bookings SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_request_note = COALESCE(cancel_request_note, ?),
         cancel_request_handled_at = NULL, updated_at = ? WHERE id = ? AND status = 'confirmed'`,
    )
    .bind(ctx.now, note || null, ctx.now, found.booking.id)
    .run();
  const fresh = await getBooking(ctx.db, found.booking.id);
  return apiOk({ booking: fresh ? await appBooking(ctx, fresh) : null });
}

/** POST /api/app/v1/forget {token} → revoke this device's token (idempotent). */
export async function apiForget(ctx: Ctx): Promise<Response> {
  const body = await readJson(ctx);
  if (body instanceof Response) return body;
  const token = body.token;
  if (typeof token === 'string' && token.length === TOKEN_LENGTH && looksLikeToken(token)) {
    await ctx.db
      .prepare(`UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND kind = 'device' AND revoked_at IS NULL`)
      .bind(ctx.now, await sha256Hex(token))
      .run();
  }
  return apiOk({ ok: true });
}

/** GET /api/app/v1/config → contact and policy links shown in the app. */
export async function apiConfig(ctx: Ctx): Promise<Response> {
  const s = await ctx.settings();
  const origin = ctx.cfg.publicOrigin;
  return apiOk({
    apiVersion: API_VERSION,
    sellerName: s.seller_name || null,
    supportEmail: s.seller_email || null,
    // App view: the same pages without site navigation or links towards booking (App Store 3.1.3(f)).
    supportUrl: `${origin}/support?view=app`,
    privacyUrl: `${origin}/privacy?view=app`,
    termsUrl: `${origin}/terms?view=app`,
    cancellationSummary: s.cancellation_summary,
  });
}

/** /.well-known/apple-app-site-association: lets /b/<token> links open the app (universal links). */
export function appleAppSiteAssociation(appIds: string | undefined): Response {
  const ids = (appIds ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(s));
  if (ids.length === 0) return new Response('Not found', { status: 404 });
  const body = { applinks: { details: [{ appIDs: ids, components: [{ '/': '/b/*', comment: 'Private booking links open in the app' }] }] } };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
