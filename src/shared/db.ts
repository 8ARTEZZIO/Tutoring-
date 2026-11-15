/** Row types and shared queries. All SQL uses bound parameters. */

export type ListingStatus = 'draft' | 'published' | 'closed' | 'cancelled';
export type BookingStatus = 'hold' | 'pending' | 'confirmed' | 'exception' | 'expired' | 'failed' | 'cancelled';

/** Statuses that occupy a seat. Holds stay occupied until Stripe proves they can no longer be paid. */
export const OCCUPYING_STATUSES: BookingStatus[] = ['hold', 'pending', 'confirmed', 'exception'];
export const OCCUPYING_SQL = `('hold','pending','confirmed','exception')`;

export interface ListingRow {
  id: string;
  slug: string;
  kind: 'single' | 'package';
  title: string;
  topic: string;
  summary: string;
  price_pence: number;
  currency: string;
  capacity: number;
  cutoff_minutes: number;
  format: string;
  tutor: string;
  status: ListingStatus;
  first_starts_at: number | null;
  last_ends_at: number | null;
  bookings_close_at: number | null;
  lesson_count: number;
  cancel_reason: string | null;
  published_at: number | null;
  closed_at: number | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LessonRow {
  id: string;
  listing_id: string;
  seq: number;
  starts_at: number;
  ends_at: number;
  meeting_url: string | null;
  uid: string;
  revision: number;
  status: 'scheduled' | 'cancelled';
  created_at: number;
  updated_at: number;
}

export interface BookingRow {
  id: string;
  listing_id: string;
  email: string;
  first_name: string;
  source: 'web' | 'invite' | 'manual';
  source_code: string;
  invite_id: string | null;
  status: BookingStatus;
  price_pence: number;
  currency: string;
  terms_version: string;
  early_start_requested: number;
  early_start_ack: number;
  early_start_text_version: string | null;
  request_nonce_hash: string | null;
  checkout_attempt_id: string | null;
  checkout_request: string | null;
  checkout_requested_at: number | null;
  checkout_expires_at: number | null;
  checkout_session_id: string | null;
  checkout_url: string | null;
  checkout_attempts: number;
  last_checkout_error: string | null;
  payment_intent_id: string | null;
  amount_paid_pence: number | null;
  stripe_livemode: number | null;
  payment_reference: string | null;
  refunded_pence: number;
  refund_pending_pence: number;
  refund_state: 'none' | 'pending' | 'partial' | 'full';
  refunds_checked_at: number | null;
  exception_reason: string | null;
  issue: string | null;
  cancel_requested_at: number | null;
  cancel_request_note: string | null;
  cancel_request_handled_at: number | null;
  confirmed_at: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
  released_at: number | null;
  last_reconciled_at: number | null;
  redacted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface InviteRow {
  id: string;
  kind: 'share' | 'individual';
  listing_id: string | null;
  code: string | null;
  token_hash: string | null;
  channel: string;
  note: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  first_opened_at: number | null;
  last_opened_at: number | null;
  open_count: number;
  created_at: number;
  created_by: string;
}

export interface WaitlistRow {
  id: string;
  listing_key: string;
  email: string;
  first_name: string | null;
  preferred_days: string | null;
  wants_seat_alert: number;
  wants_weekly_question: number;
  leave_token_hash: string | null;
  source_code: string;
  created_at: number;
  updated_at: number;
  left_at: number | null;
  alert_sent_at: number | null;
}

export interface RefundRow {
  id: string;
  booking_id: string;
  amount_pence: number;
  status: string;
  reason: string | null;
  stripe_created_at: number;
  synced_at: number;
}

export async function getListing(db: D1Database, id: string): Promise<ListingRow | null> {
  return db.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first<ListingRow>();
}

export async function getListingBySlug(db: D1Database, slug: string): Promise<ListingRow | null> {
  return db.prepare('SELECT * FROM listings WHERE slug = ?').bind(slug).first<ListingRow>();
}

export async function getLessons(db: D1Database, listingId: string): Promise<LessonRow[]> {
  const res = await db
    .prepare(`SELECT * FROM lessons WHERE listing_id = ? AND status = 'scheduled' ORDER BY starts_at, id`)
    .bind(listingId)
    .all<LessonRow>();
  return res.results;
}

export async function getAllLessons(db: D1Database, listingId: string): Promise<LessonRow[]> {
  const res = await db
    .prepare(`SELECT * FROM lessons WHERE listing_id = ? ORDER BY starts_at, id`)
    .bind(listingId)
    .all<LessonRow>();
  return res.results;
}

export async function lessonsByListing(db: D1Database, listingIds: string[]): Promise<Map<string, LessonRow[]>> {
  const map = new Map<string, LessonRow[]>();
  if (listingIds.length === 0) return map;
  const placeholders = listingIds.map(() => '?').join(',');
  const res = await db
    .prepare(`SELECT * FROM lessons WHERE status = 'scheduled' AND listing_id IN (${placeholders}) ORDER BY starts_at, id`)
    .bind(...listingIds)
    .all<LessonRow>();
  for (const row of res.results) {
    const list = map.get(row.listing_id) ?? [];
    list.push(row);
    map.set(row.listing_id, list);
  }
  return map;
}

export interface SeatCounts {
  confirmed: number;
  held: number;
  exception: number;
  occupied: number;
}

export async function seatCounts(db: D1Database, listingIds: string[]): Promise<Map<string, SeatCounts>> {
  const map = new Map<string, SeatCounts>();
  for (const id of listingIds) map.set(id, { confirmed: 0, held: 0, exception: 0, occupied: 0 });
  if (listingIds.length === 0) return map;
  const placeholders = listingIds.map(() => '?').join(',');
  const res = await db
    .prepare(
      `SELECT listing_id, status, COUNT(*) AS n FROM bookings
       WHERE listing_id IN (${placeholders}) AND status IN ${OCCUPYING_SQL}
       GROUP BY listing_id, status`,
    )
    .bind(...listingIds)
    .all<{ listing_id: string; status: BookingStatus; n: number }>();
  for (const row of res.results) {
    const c = map.get(row.listing_id)!;
    if (row.status === 'confirmed') c.confirmed += row.n;
    else if (row.status === 'exception') c.exception += row.n;
    else c.held += row.n;
    c.occupied += row.n;
  }
  return map;
}

export async function getBooking(db: D1Database, id: string): Promise<BookingRow | null> {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<BookingRow>();
}

export async function activeBookingFor(db: D1Database, listingId: string, email: string): Promise<BookingRow | null> {
  return db
    .prepare(`SELECT * FROM bookings WHERE listing_id = ? AND email = ? AND status IN ${OCCUPYING_SQL} LIMIT 1`)
    .bind(listingId, email)
    .first<BookingRow>();
}

/** Recompute denormalised schedule fields after lessons change. */
export function refreshScheduleStatements(db: D1Database, listingId: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE lessons SET seq = (
           SELECT COUNT(*) FROM lessons l2
           WHERE l2.listing_id = lessons.listing_id AND l2.status = 'scheduled'
             AND (l2.starts_at < lessons.starts_at OR (l2.starts_at = lessons.starts_at AND l2.id <= lessons.id))
         ) WHERE listing_id = ?`,
      )
      .bind(listingId),
    db
      .prepare(
        `UPDATE listings SET
           first_starts_at = (SELECT MIN(starts_at) FROM lessons WHERE listing_id = ?1 AND status = 'scheduled'),
           last_ends_at = (SELECT MAX(ends_at) FROM lessons WHERE listing_id = ?1 AND status = 'scheduled'),
           lesson_count = (SELECT COUNT(*) FROM lessons WHERE listing_id = ?1 AND status = 'scheduled'),
           bookings_close_at = (SELECT MIN(starts_at) FROM lessons WHERE listing_id = ?1 AND status = 'scheduled') - cutoff_minutes * 60,
           updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(listingId, now),
  ];
}

export type AvailabilityState =
  | 'open'
  | 'few'
  | 'held_full'
  | 'sold_out'
  | 'closed'
  | 'cutoff'
  | 'cancelled'
  | 'past'
  | 'draft'
  | 'paused';

export interface Availability {
  state: AvailabilityState;
  bookable: boolean;
  capacity: number;
  left: number;
  confirmed: number;
  held: number;
}

export function availabilityOf(listing: ListingRow, counts: SeatCounts | undefined, now: number, paused: boolean): Availability {
  const c = counts ?? { confirmed: 0, held: 0, exception: 0, occupied: 0 };
  const left = Math.max(0, listing.capacity - c.occupied);
  const base = { capacity: listing.capacity, left, confirmed: c.confirmed + c.exception, held: c.held };
  let state: AvailabilityState;
  if (listing.status === 'cancelled') state = 'cancelled';
  else if (listing.status === 'draft') state = 'draft';
  else if (!listing.last_ends_at || listing.last_ends_at <= now) state = 'past';
  else if (listing.status === 'closed') state = 'closed';
  else if (!listing.bookings_close_at || listing.bookings_close_at <= now) state = 'cutoff';
  else if (left <= 0) state = c.held > 0 ? 'held_full' : 'sold_out';
  else if (paused) state = 'paused';
  else state = left <= 2 ? 'few' : 'open';
  return { ...base, state, bookable: state === 'open' || state === 'few' };
}

/** Published (or closed-but-running) listings that have not finished yet, soonest first. */
export async function upcomingPublicListings(db: D1Database, now: number): Promise<ListingRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM listings WHERE status IN ('published','closed') AND last_ends_at > ?
       ORDER BY first_starts_at, id LIMIT 60`,
    )
    .bind(now)
    .all<ListingRow>();
  return res.results;
}

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> | null,
  now: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_actions (at, actor, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(now, actor, action, entityType, entityId, details ? JSON.stringify(details) : null)
    .run();
}

export function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO admin_actions (at, actor, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(now, actor, action, entityType, entityId, details ? JSON.stringify(details) : null);
}
