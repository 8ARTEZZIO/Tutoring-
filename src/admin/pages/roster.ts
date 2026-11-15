import { issueAccessToken } from '../../shared/access';
import { claimSeat } from '../../shared/booking';
import { toCsv } from '../../shared/csv';
import { type BookingRow, type ListingRow, audit } from '../../shared/db';
import { cleanName, cleanText, isValidEmail, normaliseEmail } from '../../shared/format';
import { type SafeHtml, html } from '../../shared/html';
import { privateHeaders } from '../../shared/http';
import { countMetric } from '../../shared/metrics';
import { fmtDate, fmtSlotUk } from '../../shared/time';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, bookingBadge, csrfField, money, table } from '../ui';
import { parsePounds } from './listings';
import { prepareConfirmation } from './messages';

const STATUS_ORDER: Record<string, number> = { confirmed: 0, exception: 1, pending: 2, hold: 3, cancelled: 4, expired: 5, failed: 6 };

export async function listingBookings(db: D1Database, listingId: string): Promise<BookingRow[]> {
  const res = await db.prepare('SELECT * FROM bookings WHERE listing_id = ? ORDER BY created_at').bind(listingId).all<BookingRow>();
  return res.results.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.created_at - b.created_at);
}

export async function rosterSection(ctx: AdminCtx, listing: ListingRow): Promise<SafeHtml> {
  const rows = await listingBookings(ctx.db, listing.id);
  const showAll = ctx.url.searchParams.get('all') === '1';
  const visible = showAll ? rows : rows.filter((b) => ['confirmed', 'exception', 'pending', 'hold'].includes(b.status) || b.cancel_requested_at);
  return html`<div class="card"><h2>Roster</h2>
    <div class="actions">
      <a class="btn small" href="/listings/${listing.id}/roster.csv">Download roster (CSV)</a>
      <a class="btn small" href="/listings/${listing.id}/roster.csv?all=1">CSV incl. unpaid/cancelled</a>
      ${showAll ? html`<a href="/listings/${listing.id}">Hide inactive</a>` : html`<a href="/listings/${listing.id}?all=1">Show expired/cancelled too</a>`}
    </div>
    ${table(
      ['Student', 'Status', 'Source', 'Price', 'Paid', 'Refunded', 'Notes', ''],
      visible.map((b) => [
        html`<strong>${b.first_name}</strong><br><span class="small">${b.email}</span>`,
        bookingBadge(b.status),
        html`${b.source}<br><span class="small muted">${b.source_code}</span>`,
        money(b.price_pence),
        money(b.amount_paid_pence),
        b.refunded_pence ? html`${money(b.refunded_pence)} <span class="small">(${b.refund_state})</span>` : '—',
        html`${b.cancel_requested_at && !b.cancel_request_handled_at ? html`<span class="badge b-warn">Cancellation requested</span> ` : ''}${b.issue ? html`<span class="badge b-bad">Issue</span>` : ''}${b.early_start_requested ? html` <span class="badge b-idle">Early start</span>` : ''}`,
        html`<a class="btn small" href="/bookings/${b.id}">Open</a>`,
      ]),
      'No bookings yet.',
    )}</div>`;
}

export async function rosterCsv(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const all = ctx.url.searchParams.get('all') === '1';
  const rows = (await listingBookings(ctx.db, listing.id)).filter((b) => all || b.status === 'confirmed' || b.status === 'exception');
  const lessons = await ctx.db
    .prepare(`SELECT starts_at, ends_at FROM lessons WHERE listing_id = ? AND status = 'scheduled' ORDER BY starts_at`)
    .bind(listing.id)
    .all<{ starts_at: number; ends_at: number }>();
  const header = [
    'booking_id', 'status', 'first_name', 'email', 'source', 'source_code', 'price_gbp', 'paid_gbp', 'refunded_gbp',
    'refund_state', 'payment_reference', 'stripe_payment_intent', 'terms_version', 'early_start_requested',
    'cancellation_requested', 'booked_at_uk', 'confirmed_at_uk',
  ];
  const data = rows.map((b) => [
    b.id, b.status, b.first_name, b.email, b.source, b.source_code, (b.price_pence / 100).toFixed(2),
    b.amount_paid_pence !== null ? (b.amount_paid_pence / 100).toFixed(2) : '', (b.refunded_pence / 100).toFixed(2),
    b.refund_state, b.payment_reference ?? '', b.payment_intent_id ?? '', b.terms_version, b.early_start_requested ? 'yes' : 'no',
    b.cancel_requested_at ? 'yes' : 'no', fmtDate(b.created_at), b.confirmed_at ? fmtDate(b.confirmed_at) : '',
  ]);
  const csv = toCsv([
    [`# ${listing.title}`],
    ...lessons.results.map((l, i) => [`# Date ${i + 1}: ${fmtSlotUk(l.starts_at, l.ends_at)}`]),
    header,
    ...data,
  ]);
  await audit(ctx.db, ctx.email, 'roster_exported', 'listing', listing.id, { rows: data.length, all }, ctx.now);
  return new Response(csv, {
    headers: {
      ...privateHeaders(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="roster-${listing.slug}.csv"`,
    },
  });
}

export function manualBookingForm(ctx: AdminCtx, listing: ListingRow): SafeHtml {
  return html`<div class="card"><h2>Register a separately paid student</h2>
    <p class="small muted">For cash, bank transfer or other payments outside Stripe. Uses the same seat limit as online bookings and issues a private link.</p>
    <form method="post" action="/listings/${listing.id}/manual-booking">${csrfField(ctx)}
      <div class="row c2">
        <div class="f"><label for="m_first">First name</label><input id="m_first" name="first_name" type="text" required maxlength="60"></div>
        <div class="f"><label for="m_email">Email</label><input id="m_email" name="email" type="email" required maxlength="254"></div>
      </div>
      <div class="row c2">
        <div class="f"><label for="m_ref">Payment reference</label><input id="m_ref" name="payment_reference" type="text" required maxlength="120" placeholder="e.g. bank transfer 12 Nov"></div>
        <div class="f"><label for="m_amount">Amount received (£)</label><input id="m_amount" name="amount" type="text" inputmode="decimal" required value="${(listing.price_pence / 100).toFixed(2)}"></div>
      </div>
      <button class="primary" type="submit">Register and issue private link</button>
    </form></div>`;
}

export async function handleManualBooking(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const firstName = cleanName(field(ctx, 'first_name'));
  const email = normaliseEmail(field(ctx, 'email'));
  const reference = cleanText(field(ctx, 'payment_reference'), 120);
  const amount = parsePounds(field(ctx, 'amount'));
  if (!firstName || !isValidEmail(email) || !reference || amount === null) {
    return back(`/listings/${listing.id}`, { err: 'Enter a first name, a valid email, a payment reference and the amount received.' });
  }
  const settings = await ctx.settings();
  const claim = await claimSeat(ctx.deps(), {
    listingId: listing.id,
    email,
    firstName,
    source: 'manual',
    sourceCode: 'manual',
    inviteId: null,
    termsVersion: settings.terms_version,
    earlyStartRequested: false,
    earlyStartAck: false,
    earlyStartTextVersion: null,
    nonceHash: null,
    status: 'confirmed',
    paymentReference: reference,
    amountPaidPence: amount,
    operatorOverride: true,
  });
  if (!claim.ok) {
    const reasons: Record<string, string> = {
      sold_out: 'No seats left (holds and confirmed bookings fill the capacity).',
      duplicate: 'That email already has an active booking for this listing.',
      not_bookable: 'This listing is cancelled.',
      cutoff: 'Bookings are closed.',
      not_found: 'Listing not found.',
    };
    return back(`/listings/${listing.id}`, { err: `Not registered: ${reasons[claim.reason] ?? claim.reason}` });
  }
  await audit(ctx.db, ctx.email, 'manual_registration', 'booking', claim.booking.id, { listing: listing.id, reference, amount }, ctx.now);
  await countMetric(ctx.db, 'paid', 'manual', ctx.now);
  const token = await issueAccessToken(ctx.db, claim.booking.id, 'link', ctx.email, ctx.now);
  const message = await prepareConfirmation(ctx, claim.booking, listing, `${ctx.cfg.publicOrigin}/b/${token}`);
  return adminLayout(ctx, {
    title: 'Student registered',
    body: html`<div class="flash">Registered ${firstName} on ${listing.title}. Their private link is in the confirmation below and is shown only once.</div>${message}`,
  });
}
