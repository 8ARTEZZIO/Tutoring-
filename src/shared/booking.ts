/**
 * Booking engine.
 *
 * Invariants:
 *  - A seat is claimed by ONE conditional INSERT that re-checks listing status, cutoff, capacity and
 *    duplicate email atomically (D1 serialises writes), backed by a partial unique index.
 *  - The exact Stripe request body is persisted before it is sent; retries replay it byte-for-byte with
 *    the same Idempotency-Key, inside Stripe's idempotency window.
 *  - Checkout expiry is a fixed timestamp (reservation + 40 min), so a late replay can never create a
 *    session that is payable after the hold should have ended.
 *  - Seats are released only after Stripe confirms the session expired unpaid, or a request definitely
 *    failed. Uncertain outcomes keep the seat held and are surfaced to the operator.
 *  - Webhooks, browser returns, cron and operator rechecks all converge on applySession()/fulfil(),
 *    which only ever moves a booking forward through valid transitions.
 */

import { APP_ID, type AppConfig } from './config';
import { randomId } from './crypto';
import {
  type BookingRow,
  type LessonRow,
  type ListingRow,
  OCCUPYING_SQL,
  audit,
  auditStatement,
  getBooking,
  getLessons,
  getListing,
} from './db';
import { log } from './http';
import { countStatement } from './metrics';
import { type CheckoutSession, type StripeClient, StripeError, formEncode, paymentIntentId } from './stripe';
import { fmtSlotUk } from './time';

export const CHECKOUT_TTL_SECONDS = 40 * 60;
/** Stripe keeps idempotency keys for at least 24h; stay well inside that. */
export const REPLAY_WINDOW_SECONDS = 23 * 3600;
export const COOLING_OFF_SECONDS = 14 * 86_400;

export interface Deps {
  db: D1Database;
  cfg: AppConfig;
  stripe: StripeClient;
  now: number;
}

// ---- Seat claim ---------------------------------------------------------------------------------

export interface ClaimInput {
  listingId: string;
  email: string;
  firstName: string;
  source: 'web' | 'invite' | 'manual';
  sourceCode: string;
  inviteId: string | null;
  termsVersion: string;
  earlyStartRequested: boolean;
  earlyStartAck: boolean;
  earlyStartTextVersion: string | null;
  nonceHash: string | null;
  /** 'hold' for online checkout; 'confirmed' for operator-recorded offline payments. */
  status: 'hold' | 'confirmed';
  paymentReference?: string | null;
  amountPaidPence?: number | null;
  /** Operator registrations may add to draft or closed listings and ignore the online cutoff. */
  operatorOverride?: boolean;
}

export type ClaimFailure = 'not_found' | 'not_bookable' | 'cutoff' | 'sold_out' | 'duplicate';

export async function claimSeat(
  deps: Deps,
  input: ClaimInput,
): Promise<{ ok: true; booking: BookingRow } | { ok: false; reason: ClaimFailure }> {
  const { db, now } = deps;
  const id = randomId('bk');
  const attemptId = input.status === 'hold' ? randomId('att', 20) : null;
  // Online bookings also honour the dashboard pause switch inside the same atomic statement.
  const statusClause = input.operatorOverride
    ? `l.status IN ('draft','published','closed') AND l.last_ends_at > ?16`
    : `l.status = 'published' AND l.bookings_close_at IS NOT NULL AND l.bookings_close_at > ?16
       AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'bookings_paused' AND s.value = '1')`;
  const sql = `
    INSERT INTO bookings (
      id, listing_id, email, first_name, source, source_code, invite_id, status,
      price_pence, currency, terms_version, early_start_requested, early_start_ack, early_start_text_version,
      request_nonce_hash, checkout_attempt_id, payment_reference, amount_paid_pence, confirmed_at,
      created_at, updated_at)
    SELECT ?1, l.id, ?2, ?3, ?4, ?5, ?6, ?7,
      l.price_pence, l.currency, ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, ?15, CASE WHEN ?7 = 'confirmed' THEN ?16 ELSE NULL END,
      ?16, ?16
    FROM listings l
    WHERE l.id = ?17
      AND ${statusClause}
      AND (SELECT COUNT(*) FROM bookings b WHERE b.listing_id = l.id AND b.status IN ${OCCUPYING_SQL}) < l.capacity
      AND NOT EXISTS (
        SELECT 1 FROM bookings b2 WHERE b2.listing_id = l.id AND b2.email = ?2 AND b2.status IN ${OCCUPYING_SQL})
    RETURNING *`;
  let row: BookingRow | null = null;
  try {
    row = await db
      .prepare(sql)
      .bind(
        id,
        input.email,
        input.firstName,
        input.source,
        input.sourceCode,
        input.inviteId,
        input.status,
        input.termsVersion,
        input.earlyStartRequested ? 1 : 0,
        input.earlyStartAck ? 1 : 0,
        input.earlyStartTextVersion,
        input.nonceHash,
        attemptId,
        input.paymentReference ?? null,
        input.amountPaidPence ?? null,
        now,
        input.listingId,
      )
      .first<BookingRow>();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return { ok: false, reason: 'duplicate' };
    throw e;
  }
  if (row) return { ok: true, booking: row };

  const listing = await getListing(db, input.listingId);
  if (!listing) return { ok: false, reason: 'not_found' };
  const statusOk = input.operatorOverride
    ? listing.status !== 'cancelled'
    : listing.status === 'published';
  if (!statusOk) return { ok: false, reason: 'not_bookable' };
  if (!input.operatorOverride) {
    const paused = await db.prepare(`SELECT 1 FROM settings WHERE key = 'bookings_paused' AND value = '1'`).first();
    if (paused) return { ok: false, reason: 'not_bookable' };
  }
  if (!input.operatorOverride && (!listing.bookings_close_at || listing.bookings_close_at <= now)) {
    return { ok: false, reason: 'cutoff' };
  }
  const dup = await db
    .prepare(`SELECT id FROM bookings WHERE listing_id = ? AND email = ? AND status IN ${OCCUPYING_SQL}`)
    .bind(input.listingId, input.email)
    .first();
  if (dup) return { ok: false, reason: 'duplicate' };
  return { ok: false, reason: 'sold_out' };
}

// ---- Checkout request ---------------------------------------------------------------------------

export function checkoutDates(lessons: LessonRow[]): string[] {
  return lessons.map((l) => fmtSlotUk(l.starts_at, l.ends_at));
}

export function buildCheckoutRequest(booking: BookingRow, listing: ListingRow, lessons: LessonRow[], cfg: AppConfig): string {
  const dates = checkoutDates(lessons);
  const name = listing.kind === 'package' ? `${listing.title} (${lessons.length} sessions)` : listing.title;
  let description = dates.join(' · ');
  if (description.length > 900) description = description.slice(0, 897) + '...';
  const origin = cfg.publicOrigin;
  const pairs: [string, string | number][] = [
    ['mode', 'payment'],
    ['client_reference_id', booking.id],
    ['customer_email', booking.email],
    ['locale', 'en-GB'],
    ['submit_type', 'book'],
    ['payment_method_types[0]', 'card'],
    ['line_items[0][quantity]', 1],
    ['line_items[0][price_data][currency]', booking.currency],
    ['line_items[0][price_data][unit_amount]', booking.price_pence],
    ['line_items[0][price_data][product_data][name]', name],
    ['line_items[0][price_data][product_data][description]', description],
    ['metadata[app]', APP_ID],
    ['metadata[env]', cfg.stripe.envTag],
    ['metadata[booking_id]', booking.id],
    ['metadata[listing_id]', listing.id],
    ['metadata[attempt_id]', booking.checkout_attempt_id ?? ''],
    ['payment_intent_data[description]', `${listing.title} - booking ${booking.id}`],
    ['payment_intent_data[metadata][app]', APP_ID],
    ['payment_intent_data[metadata][env]', cfg.stripe.envTag],
    ['payment_intent_data[metadata][booking_id]', booking.id],
    ['expires_at', booking.created_at + CHECKOUT_TTL_SECONDS],
    ['success_url', `${origin}/checkout/return?b=${booking.id}&session_id={CHECKOUT_SESSION_ID}`],
    ['cancel_url', `${origin}/checkout/cancelled?b=${booking.id}`],
    [
      'custom_text[submit][message]',
      `One payment books one seat on ${lessons.length === 1 ? 'this date' : `all ${lessons.length} dates`} (UK time). Booking terms version ${booking.terms_version}.`,
    ],
  ];
  return formEncode(pairs);
}

// ---- Outcomes -----------------------------------------------------------------------------------

export type CheckoutOutcome =
  | { kind: 'redirect'; url: string; booking: BookingRow }
  | { kind: 'confirmed'; booking: BookingRow }
  | { kind: 'processing'; booking: BookingRow }
  | { kind: 'uncertain'; booking: BookingRow }
  | { kind: 'released'; booking: BookingRow; reason: 'expired' | 'failed' | 'cancelled' }
  | { kind: 'exception'; booking: BookingRow };

export function outcomeFor(b: BookingRow): CheckoutOutcome {
  switch (b.status) {
    case 'confirmed':
      return { kind: 'confirmed', booking: b };
    case 'exception':
      return { kind: 'exception', booking: b };
    case 'expired':
      return { kind: 'released', booking: b, reason: 'expired' };
    case 'failed':
      return { kind: 'released', booking: b, reason: 'failed' };
    case 'cancelled':
      return { kind: 'released', booking: b, reason: 'cancelled' };
    case 'pending':
      return { kind: 'processing', booking: b };
    default:
      return { kind: 'uncertain', booking: b };
  }
}

async function reload(deps: Deps, id: string): Promise<BookingRow> {
  const b = await getBooking(deps.db, id);
  if (!b) throw new Error(`booking ${id} disappeared`);
  return b;
}

export function checkoutUrlAllowed(cfg: AppConfig, url: string | null): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return cfg.stripe.checkoutOrigins.includes(u.origin) && (u.protocol === 'https:' || !cfg.isProduction);
  } catch {
    return false;
  }
}

async function setIssue(deps: Deps, booking: BookingRow, issue: string, error?: string): Promise<BookingRow> {
  await deps.db
    .prepare(
      `UPDATE bookings SET issue = ?, last_checkout_error = COALESCE(?, last_checkout_error), last_reconciled_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(issue, error ?? null, deps.now, deps.now, booking.id)
    .run();
  return reload(deps, booking.id);
}

// ---- Create / replay ----------------------------------------------------------------------------

/** For a 'hold': create the Checkout Session, or replay the stored request to learn what happened. */
export async function createOrReplay(deps: Deps, bookingIn: BookingRow): Promise<CheckoutOutcome> {
  const { db, now } = deps;
  let booking = bookingIn;
  if (booking.status !== 'hold') return ensureCheckout(deps, booking);
  if (!booking.checkout_request) {
    const listing = await getListing(db, booking.listing_id);
    if (!listing) throw new Error('listing missing');
    const lessons = await getLessons(db, listing.id);
    const body = buildCheckoutRequest(booking, listing, lessons, deps.cfg);
    await db
      .prepare(
        `UPDATE bookings SET checkout_request = ?, checkout_requested_at = ?, checkout_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'hold' AND checkout_request IS NULL`,
      )
      .bind(body, now, booking.created_at + CHECKOUT_TTL_SECONDS, now, booking.id)
      .run();
    booking = await reload(deps, booking.id);
    if (booking.status !== 'hold' || !booking.checkout_request) return outcomeFor(booking);
  }
  if (now - (booking.checkout_requested_at ?? booking.created_at) > REPLAY_WINDOW_SECONDS) {
    return recoverByLookup(deps, booking);
  }
  let session: CheckoutSession;
  try {
    session = await deps.stripe.createCheckoutSession(booking.checkout_request, booking.checkout_attempt_id ?? booking.id);
  } catch (e) {
    return handleCreateError(deps, booking, e);
  }
  return applySession(deps, booking, session, 'create');
}

async function handleCreateError(deps: Deps, booking: BookingRow, e: unknown): Promise<CheckoutOutcome> {
  const { db, now } = deps;
  const message = (e instanceof StripeError ? `${e.status ?? 'no response'} ${e.code ?? ''} ${e.message}` : String(e)).slice(0, 300);
  if (e instanceof StripeError && e.certainty === 'definite') {
    // Stripe validated and rejected the request (on a replay this also proves the original never ran).
    await db
      .prepare(
        `UPDATE bookings SET status = 'failed', released_at = ?, last_checkout_error = ?, checkout_attempts = checkout_attempts + 1,
           issue = NULL, updated_at = ?
         WHERE id = ? AND status = 'hold'`,
      )
      .bind(now, message, now, booking.id)
      .run();
    log('warn', 'checkout_create_failed', { booking: booking.id, status: e.status, code: e.code });
    return outcomeFor(await reload(deps, booking.id));
  }
  log('warn', 'checkout_create_uncertain', { booking: booking.id, status: e instanceof StripeError ? e.status : null });
  await db
    .prepare(
      `UPDATE bookings SET last_checkout_error = ?, checkout_attempts = checkout_attempts + 1, issue = ?, updated_at = ?
       WHERE id = ? AND status = 'hold'`,
    )
    .bind(
      message,
      'Checkout creation outcome unknown (no or failed response from Stripe). Seat is held until Stripe confirms.',
      now,
      booking.id,
    )
    .run();
  return outcomeFor(await reload(deps, booking.id));
}

/** Beyond the idempotency window: search Stripe for a session carrying this booking id. */
async function recoverByLookup(deps: Deps, booking: BookingRow): Promise<CheckoutOutcome> {
  const from = (booking.checkout_requested_at ?? booking.created_at) - 300;
  let sessions: CheckoutSession[];
  try {
    sessions = await deps.stripe.listCheckoutSessions({ createdGte: from, createdLte: from + 3 * 3600 });
  } catch (e) {
    return outcomeFor(await setIssue(deps, booking, 'Stripe lookup failed; seat still held.', String(e).slice(0, 200)));
  }
  const match = sessions.find((s) => s.client_reference_id === booking.id && s.metadata?.booking_id === booking.id);
  if (match) return applySession(deps, booking, match, 'lookup');
  const expiry = booking.checkout_expires_at ?? booking.created_at + CHECKOUT_TTL_SECONDS;
  if (deps.now > expiry + 600) {
    await deps.db
      .prepare(
        `UPDATE bookings SET status = 'failed', released_at = ?, issue = NULL,
           last_checkout_error = 'No Checkout Session for this booking exists in Stripe', updated_at = ?
         WHERE id = ? AND status = 'hold'`,
      )
      .bind(deps.now, deps.now, booking.id)
      .run();
    return outcomeFor(await reload(deps, booking.id));
  }
  return outcomeFor(booking);
}

// ---- Applying Stripe's view of a session ----------------------------------------------------------

export async function applySession(
  deps: Deps,
  booking: BookingRow,
  session: CheckoutSession,
  via: string,
  releaseAs: 'expired' | 'cancelled' = 'expired',
): Promise<CheckoutOutcome> {
  const meta = session.metadata ?? {};
  if (session.client_reference_id !== booking.id || meta.booking_id !== booking.id || meta.app !== APP_ID) {
    log('warn', 'session_not_for_booking', { booking: booking.id, via });
    return outcomeFor(booking);
  }
  if (booking.checkout_session_id && booking.checkout_session_id !== session.id) {
    if (session.payment_status === 'paid') {
      return markException(deps, booking, session, 'Paid through a different Checkout Session than the one recorded');
    }
    log('warn', 'session_id_mismatch', { booking: booking.id, via });
    return outcomeFor(booking);
  }
  if (session.status === 'complete' && session.payment_status === 'paid') return fulfil(deps, booking, session, via);
  if (session.status === 'expired') return releaseExpired(deps, booking, session, releaseAs);
  if (session.status === 'complete' && session.payment_status === 'unpaid') {
    // Only possible with delayed payment methods. A failed delayed payment can never complete this session.
    const pi = session.payment_intent;
    if (pi && typeof pi === 'object' && (pi.status === 'canceled' || pi.status === 'requires_payment_method')) {
      await deps.db
        .prepare(
          `UPDATE bookings SET status = 'failed', released_at = ?, checkout_session_id = COALESCE(checkout_session_id, ?),
             last_checkout_error = 'Delayed payment failed', issue = NULL, updated_at = ?
           WHERE id = ? AND status IN ('hold','pending')`,
        )
        .bind(deps.now, session.id, deps.now, booking.id)
        .run();
      return outcomeFor(await reload(deps, booking.id));
    }
  }

  // Open (or complete with payment still processing).
  if (session.livemode !== deps.cfg.stripe.livemode || session.amount_total !== booking.price_pence) {
    if (session.status === 'open') {
      try {
        await deps.stripe.expireCheckoutSession(session.id); // never leave a wrong session payable
      } catch {
        // surfaced through the exception below
      }
    }
    return markException(deps, booking, session, 'Checkout Session does not match the booking (amount or mode)');
  }
  if (booking.status === 'hold') {
    await deps.db
      .prepare(
        `UPDATE bookings SET status = 'pending', checkout_session_id = ?, checkout_url = ?, checkout_expires_at = ?,
           checkout_attempts = checkout_attempts + 1, issue = NULL, last_checkout_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'hold'`,
      )
      .bind(session.id, session.url, session.expires_at, deps.now, booking.id)
      .run();
  } else if (booking.status === 'pending') {
    await deps.db
      .prepare('UPDATE bookings SET last_reconciled_at = ?, checkout_expires_at = ? WHERE id = ?')
      .bind(deps.now, session.expires_at, booking.id)
      .run();
  }
  const fresh = await reload(deps, booking.id);
  if (fresh.status !== 'pending') return outcomeFor(fresh);
  const listing = await getListing(deps.db, fresh.listing_id);
  if (listing?.status === 'cancelled' && session.status === 'open') {
    return expireAndRelease(deps, fresh, 'cancelled');
  }
  if (session.status === 'open' && checkoutUrlAllowed(deps.cfg, session.url) && deps.now < session.expires_at - 60) {
    return { kind: 'redirect', url: session.url, booking: fresh };
  }
  return { kind: 'processing', booking: fresh };
}

function paymentProblems(deps: Deps, booking: BookingRow, session: CheckoutSession): string[] {
  const problems: string[] = [];
  const meta = session.metadata ?? {};
  if (session.amount_total !== booking.price_pence) {
    problems.push(`amount ${session.amount_total} does not match price ${booking.price_pence}`);
  }
  if ((session.currency ?? '').toLowerCase() !== booking.currency.toLowerCase()) {
    problems.push(`currency ${session.currency} does not match ${booking.currency}`);
  }
  if (session.livemode !== deps.cfg.stripe.livemode) problems.push('Stripe mode (live/test) does not match this environment');
  if (meta.env !== deps.cfg.stripe.envTag) problems.push(`environment tag ${meta.env} does not match ${deps.cfg.stripe.envTag}`);
  if (!paymentIntentId(session)) problems.push('no PaymentIntent on a paid session');
  return problems;
}

async function markException(deps: Deps, booking: BookingRow, session: CheckoutSession, reason: string): Promise<CheckoutOutcome> {
  const { db, now } = deps;
  const pi = paymentIntentId(session);
  const issue = 'Payment needs review: ' + reason;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE bookings SET status = 'exception', exception_reason = ?, issue = ?,
             payment_intent_id = COALESCE(payment_intent_id, ?), amount_paid_pence = ?, last_reconciled_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('hold','pending','expired','failed','cancelled')`,
        )
        .bind(reason, issue, pi, session.payment_status === 'paid' ? session.amount_total : null, now, now, booking.id),
      auditStatement(db, 'system', 'payment_exception', 'booking', booking.id, { reason, session: session.id }, now),
    ]);
  } catch (e) {
    // e.g. the same email re-booked after this seat was released: keep status, but flag loudly.
    log('error', 'exception_update_failed', { booking: booking.id, error: String(e).slice(0, 200) });
    await db
      .prepare('UPDATE bookings SET exception_reason = ?, issue = ?, updated_at = ? WHERE id = ?')
      .bind(reason, issue, now, booking.id)
      .run();
  }
  log('error', 'payment_exception', { booking: booking.id, reason });
  return outcomeFor(await reload(deps, booking.id));
}

/** The single fulfilment path. Idempotent: concurrent callers converge on one confirmed row. */
export async function fulfil(deps: Deps, booking: BookingRow, session: CheckoutSession, via: string): Promise<CheckoutOutcome> {
  const { db, now } = deps;
  const problems = paymentProblems(deps, booking, session);
  if (problems.length) return markException(deps, booking, session, problems.join('; '));
  const pi = paymentIntentId(session);
  const res = await db
    .prepare(
      `UPDATE bookings SET status = 'confirmed', confirmed_at = ?, checkout_session_id = COALESCE(checkout_session_id, ?),
         payment_intent_id = ?, amount_paid_pence = ?, stripe_livemode = ?, issue = NULL, last_checkout_error = NULL,
         last_reconciled_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('hold','pending')`,
    )
    .bind(now, session.id, pi, session.amount_total, session.livemode ? 1 : 0, now, now, booking.id)
    .run();
  if (res.meta.changes === 1) {
    await db.batch([
      countStatement(db, 'paid', booking.source_code, now),
      auditStatement(db, 'system', 'payment_confirmed', 'booking', booking.id, { via, amount: session.amount_total }, now),
    ]);
    log('info', 'booking_confirmed', { booking: booking.id, via });
    return outcomeFor(await reload(deps, booking.id));
  }
  const fresh = await reload(deps, booking.id);
  if (fresh.status === 'confirmed' || fresh.status === 'exception') return outcomeFor(fresh);
  if (fresh.status === 'expired' || fresh.status === 'failed' || fresh.status === 'cancelled') {
    return markException(deps, fresh, session, 'Payment received after the seat was released');
  }
  return outcomeFor(fresh);
}

async function releaseExpired(
  deps: Deps,
  booking: BookingRow,
  session: CheckoutSession,
  releaseAs: 'expired' | 'cancelled',
): Promise<CheckoutOutcome> {
  const { db, now } = deps;
  const status = releaseAs === 'cancelled' ? 'cancelled' : 'expired';
  const res = await db
    .prepare(
      `UPDATE bookings SET status = ?, released_at = ?, checkout_session_id = COALESCE(checkout_session_id, ?), issue = NULL,
         cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
         cancel_reason = CASE WHEN ? = 'cancelled' THEN COALESCE(cancel_reason, 'Cancelled before payment') ELSE cancel_reason END,
         last_reconciled_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('hold','pending')`,
    )
    .bind(status, now, session.id, status, now, status, now, now, booking.id)
    .run();
  if (res.meta.changes === 1) log('info', 'hold_released', { booking: booking.id, as: status });
  return outcomeFor(await reload(deps, booking.id));
}

/** Expire the booking's Checkout Session in Stripe and release the seat once Stripe confirms. */
export async function expireAndRelease(
  deps: Deps,
  bookingIn: BookingRow,
  reason: 'expired' | 'cancelled',
): Promise<CheckoutOutcome> {
  let booking = bookingIn;
  if (booking.status === 'hold') {
    const outcome = await createOrReplay(deps, booking);
    if (outcome.kind !== 'redirect' && outcome.kind !== 'processing') return outcome;
    booking = outcome.booking;
  }
  if (booking.status !== 'pending' || !booking.checkout_session_id) return outcomeFor(booking);
  let session: CheckoutSession;
  try {
    session = await deps.stripe.expireCheckoutSession(booking.checkout_session_id);
  } catch (e) {
    if (e instanceof StripeError && e.certainty === 'definite') {
      // Already completed or expired: ask Stripe which.
      try {
        const current = await deps.stripe.retrieveCheckoutSession(booking.checkout_session_id);
        if (current) return applySession(deps, booking, current, 'expire-check', reason);
      } catch {
        // fall through to uncertain
      }
    }
    return outcomeFor(await setIssue(deps, booking, 'Could not expire the Checkout Session in Stripe; seat still held.', String(e).slice(0, 200)));
  }
  return applySession(deps, booking, session, 'expire', reason);
}

// ---- Reconciliation -----------------------------------------------------------------------------

/** Bring a booking in line with Stripe. Safe to call repeatedly from any path. */
export async function reconcileBooking(deps: Deps, booking: BookingRow, via: string): Promise<CheckoutOutcome> {
  if (booking.status === 'hold') return createOrReplay(deps, booking);
  if (booking.status !== 'pending') return outcomeFor(booking);
  if (!booking.checkout_session_id) return createOrReplay(deps, booking);
  let session: CheckoutSession | null;
  try {
    session = await deps.stripe.retrieveCheckoutSession(booking.checkout_session_id);
  } catch (e) {
    return outcomeFor(await setIssue(deps, booking, 'Stripe could not be reached to check this payment; seat still held.', String(e).slice(0, 200)));
  }
  if (!session) {
    return outcomeFor(await setIssue(deps, booking, 'Recorded Checkout Session was not found in Stripe. Check the Stripe Dashboard.'));
  }
  if (session.status === 'open' && deps.now > session.expires_at + 300) {
    return expireAndRelease(deps, booking, 'expired');
  }
  return applySession(deps, booking, session, via);
}

/** Resume an existing booking for an authorised student: send them back to an open Checkout if possible. */
export async function ensureCheckout(deps: Deps, booking: BookingRow): Promise<CheckoutOutcome> {
  switch (booking.status) {
    case 'hold':
      return createOrReplay(deps, booking);
    case 'pending':
      return reconcileBooking(deps, booking, 'resume');
    default:
      return outcomeFor(booking);
  }
}

/** Cron batch: stale holds, pending sessions past expiry or never checked, refunds still pending. */
export async function reconcileStale(deps: Deps, limit = 10): Promise<{ checked: number; results: Record<string, number> }> {
  const { db, now } = deps;
  const rows = await db
    .prepare(
      `SELECT * FROM bookings
       WHERE (status = 'hold' AND updated_at < ?1)
          OR (status = 'pending' AND (
                checkout_expires_at < ?2
             OR (last_reconciled_at IS NULL AND created_at < ?3)
             OR (last_reconciled_at IS NOT NULL AND last_reconciled_at < ?4)))
       ORDER BY updated_at ASC LIMIT ?5`,
    )
    .bind(now - 30, now - 60, now - 900, now - 1800, limit)
    .all<BookingRow>();
  const results: Record<string, number> = {};
  for (const b of rows.results) {
    try {
      const outcome = await reconcileBooking(deps, b, 'cron');
      results[outcome.kind] = (results[outcome.kind] ?? 0) + 1;
    } catch (e) {
      results.error = (results.error ?? 0) + 1;
      log('error', 'reconcile_failed', { booking: b.id, error: String(e).slice(0, 200) });
    }
  }
  const refundRows = await db
    .prepare(
      `SELECT * FROM bookings WHERE refund_state = 'pending' AND payment_intent_id IS NOT NULL
         AND (refunds_checked_at IS NULL OR refunds_checked_at < ?) LIMIT 5`,
    )
    .bind(now - 3600)
    .all<BookingRow>();
  for (const b of refundRows.results) {
    try {
      await syncRefunds(deps, b);
      results.refunds = (results.refunds ?? 0) + 1;
    } catch {
      results.error = (results.error ?? 0) + 1;
    }
  }
  await db.prepare('DELETE FROM rate_limits WHERE win < ?').bind(now - 86_400).run();
  return { checked: rows.results.length + refundRows.results.length, results };
}

// ---- Refunds ------------------------------------------------------------------------------------

/** Pull refund state from Stripe (never inferred locally). */
export async function syncRefunds(deps: Deps, booking: BookingRow): Promise<BookingRow> {
  const { db, now } = deps;
  if (!booking.payment_intent_id) return booking;
  const refunds = await deps.stripe.listRefunds(booking.payment_intent_id);
  const statements: D1PreparedStatement[] = refunds.map((r) =>
    db
      .prepare(
        `INSERT INTO refunds (id, booking_id, amount_pence, status, reason, stripe_created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount_pence = excluded.amount_pence, status = excluded.status,
           reason = excluded.reason, synced_at = excluded.synced_at`,
      )
      .bind(r.id, booking.id, r.amount, r.status, r.reason, r.created, now),
  );
  const succeeded = refunds.filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.amount, 0);
  const pending = refunds.filter((r) => r.status === 'pending' || r.status === 'requires_action').reduce((s, r) => s + r.amount, 0);
  const paid = booking.amount_paid_pence ?? booking.price_pence;
  const state = paid > 0 && succeeded >= paid ? 'full' : succeeded > 0 ? 'partial' : pending > 0 ? 'pending' : 'none';
  const fullIssue = 'Fully refunded in Stripe. Release the seat if this student is no longer attending.';
  statements.push(
    db
      .prepare(
        `UPDATE bookings SET refunded_pence = ?, refund_pending_pence = ?, refund_state = ?, refunds_checked_at = ?,
           issue = CASE WHEN ? = 'full' AND status = 'confirmed' THEN ? WHEN issue = ? THEN NULL ELSE issue END,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(succeeded, pending, state, now, state, fullIssue, fullIssue, now, booking.id),
  );
  await db.batch(statements);
  return reload(deps, booking.id);
}

/** Release a seat only once Stripe shows the payment fully refunded. */
export async function releaseIfFullyRefunded(deps: Deps, booking: BookingRow, actor: string): Promise<{ ok: boolean; message: string }> {
  if (booking.status !== 'confirmed') return { ok: false, message: 'Only confirmed bookings can be released this way.' };
  if (!booking.payment_intent_id) return { ok: false, message: 'This booking has no Stripe payment to verify. Use "Cancel seat" instead.' };
  const fresh = await syncRefunds(deps, booking);
  if (fresh.refund_state !== 'full') {
    return { ok: false, message: `Stripe shows ${fresh.refunded_pence}p refunded of ${fresh.amount_paid_pence ?? fresh.price_pence}p. The seat stays booked.` };
  }
  const { db, now } = deps;
  await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, released_at = ?, cancel_reason = 'Fully refunded',
           issue = NULL, updated_at = ? WHERE id = ? AND status = 'confirmed'`,
      )
      .bind(now, now, now, booking.id),
    auditStatement(db, actor, 'seat_released_refunded', 'booking', booking.id, { refunded: fresh.refunded_pence }, now),
  ]);
  return { ok: true, message: 'Verified full refund in Stripe; seat released.' };
}

/** Operator seat cancellation (separate from refunds). Unpaid holds are expired in Stripe first. */
export async function cancelSeat(deps: Deps, booking: BookingRow, actor: string, reason: string): Promise<{ ok: boolean; message: string }> {
  const { db, now } = deps;
  if (booking.status === 'hold' || booking.status === 'pending') {
    const outcome = await expireAndRelease(deps, booking, 'cancelled');
    if (outcome.kind === 'released') {
      await audit(db, actor, 'seat_cancelled', 'booking', booking.id, { reason, before: booking.status }, now);
      return { ok: true, message: 'Checkout expired in Stripe and the seat was released.' };
    }
    if (outcome.kind === 'confirmed') return { ok: false, message: 'Stripe shows this booking was paid; it is now confirmed. Cancel again to release the seat.' };
    return { ok: false, message: 'Stripe did not confirm the checkout is closed. The seat stays held; try again shortly.' };
  }
  if (booking.status === 'confirmed' || booking.status === 'exception') {
    await db.batch([
      db
        .prepare(
          `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, released_at = ?, cancel_reason = ?, issue = NULL, updated_at = ?
           WHERE id = ? AND status IN ('confirmed','exception')`,
        )
        .bind(now, now, reason || 'Cancelled by operator', now, booking.id),
      auditStatement(db, actor, 'seat_cancelled', 'booking', booking.id, { reason, before: booking.status, refunded: booking.refunded_pence }, now),
    ]);
    return { ok: true, message: 'Seat cancelled and released. Refunds are handled separately in Stripe.' };
  }
  return { ok: false, message: 'This booking does not hold a seat.' };
}

// ---- Listing cancellation -----------------------------------------------------------------------

export interface CancellationReport {
  releasedUnpaid: number;
  confirmed: BookingRow[];
  unresolved: BookingRow[];
}

export async function cancelListing(deps: Deps, listingId: string, reason: string, actor: string): Promise<CancellationReport> {
  const { db, now } = deps;
  // Stop new checkouts immediately: claimSeat requires status = 'published'.
  await db.batch([
    db
      .prepare(
        `UPDATE listings SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), cancel_reason = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, reason, now, listingId),
    db.prepare(`UPDATE lessons SET revision = revision + 1, updated_at = ? WHERE listing_id = ?`).bind(now, listingId),
    auditStatement(db, actor, 'listing_cancelled', 'listing', listingId, { reason }, now),
  ]);
  return settleCancelledListing(deps, listingId);
}

/** Expire every in-flight checkout of a cancelled listing and report what the operator must do. */
export async function settleCancelledListing(deps: Deps, listingId: string): Promise<CancellationReport> {
  const { db } = deps;
  const inFlight = await db
    .prepare(`SELECT * FROM bookings WHERE listing_id = ? AND status IN ('hold','pending')`)
    .bind(listingId)
    .all<BookingRow>();
  let releasedUnpaid = 0;
  for (const b of inFlight.results) {
    try {
      const outcome = await expireAndRelease(deps, b, 'cancelled');
      if (outcome.kind === 'released') releasedUnpaid++;
    } catch (e) {
      log('error', 'cancel_release_failed', { booking: b.id, error: String(e).slice(0, 200) });
    }
  }
  const rest = await db
    .prepare(`SELECT * FROM bookings WHERE listing_id = ? AND status IN ${OCCUPYING_SQL} ORDER BY created_at`)
    .bind(listingId)
    .all<BookingRow>();
  return {
    releasedUnpaid,
    confirmed: rest.results.filter((b) => b.status === 'confirmed'),
    unresolved: rest.results.filter((b) => b.status !== 'confirmed'),
  };
}
