import { issueAccessToken } from '../../shared/access';
import { reconcileStale } from '../../shared/booking';
import {
  type BookingRow,
  type ListingRow,
  audit,
  availabilityOf,
  getListing,
  seatCounts,
} from '../../shared/db';
import { html } from '../../shared/html';
import { saveSettings, sellerReady } from '../../shared/settings';
import { fmtDate, fmtSlotUk } from '../../shared/time';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, bookingBadge, csrfField, listingBadge, money, postButton, table } from '../ui';
import { prepareConfirmation } from './messages';

export async function renderDashboard(ctx: AdminCtx): Promise<Response> {
  const settings = await ctx.settings();
  const listings = await ctx.db
    .prepare(
      `SELECT * FROM listings WHERE status != 'cancelled' OR cancelled_at > ?
       ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END, COALESCE(first_starts_at, created_at)`,
    )
    .bind(ctx.now - 60 * 86_400)
    .all<ListingRow>();
  const counts = await seatCounts(ctx.db, listings.results.map((l) => l.id));
  const revenue = await ctx.db
    .prepare(
      `SELECT listing_id, SUM(COALESCE(amount_paid_pence, 0)) AS paid, SUM(refunded_pence) AS refunded FROM bookings
       WHERE status IN ('confirmed','exception','cancelled') AND amount_paid_pence IS NOT NULL GROUP BY listing_id`,
    )
    .all<{ listing_id: string; paid: number; refunded: number }>();
  const rev = new Map(revenue.results.map((r) => [r.listing_id, r]));
  const issues = await ctx.db
    .prepare(
      `SELECT b.*, l.title AS listing_title FROM bookings b JOIN listings l ON l.id = b.listing_id
       WHERE b.issue IS NOT NULL OR b.status = 'exception' OR (b.status = 'hold' AND b.updated_at < ?)
       ORDER BY b.updated_at DESC LIMIT 50`,
    )
    .bind(ctx.now - 120)
    .all<BookingRow & { listing_title: string }>();
  const cancelRequests = await ctx.db
    .prepare(
      `SELECT b.*, l.title AS listing_title FROM bookings b JOIN listings l ON l.id = b.listing_id
       WHERE b.cancel_requested_at IS NOT NULL AND b.cancel_request_handled_at IS NULL ORDER BY b.cancel_requested_at`,
    )
    .all<BookingRow & { listing_title: string }>();
  const linkRequests = await ctx.db
    .prepare('SELECT * FROM link_requests WHERE handled_at IS NULL ORDER BY created_at LIMIT 50')
    .all<{ id: string; email: string; created_at: number }>();
  const pending = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status IN ('hold','pending')`)
    .first<{ n: number }>();
  const waitlist = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM waitlist WHERE left_at IS NULL')
    .first<{ n: number }>();
  const unnotified = await ctx.db
    .prepare(`SELECT lc.listing_id, l.title, COUNT(*) AS n FROM lesson_changes lc JOIN listings l ON l.id = lc.listing_id WHERE lc.notified_at IS NULL GROUP BY lc.listing_id`)
    .all<{ listing_id: string; title: string; n: number }>();

  const paused = settings.bookings_paused === '1' || ctx.cfg.bookingsPausedByEnv;
  const problems = [...ctx.cfg.problems];
  if (!sellerReady(settings)) problems.push('Seller name, address and contact email are not set (Settings). Required before taking payments.');

  const body = html`<h1>Overview</h1>
    <div class="actions">
      <span class="badge ${paused ? 'pill-paused' : 'pill-live'}">${paused ? 'New bookings PAUSED' : 'Bookings live'}</span>
      <span class="badge b-idle">Stripe ${ctx.cfg.stripe.mode} mode</span>
      ${ctx.cfg.bookingsPausedByEnv
        ? html`<span class="small">Paused by the BOOKINGS_PAUSED environment variable.</span>`
        : postButton(ctx, '/pause', paused ? 'Resume bookings' : 'Pause all new bookings', { cls: paused ? 'primary small' : 'danger small', fields: { paused: paused ? '0' : '1' }, confirm: paused ? 'Resume new bookings?' : 'Pause all new bookings? Existing checkouts can still be paid.' })}
      ${postButton(ctx, '/reconcile', 'Reconcile payments with Stripe now')}
      <a class="btn small primary" href="/listings/new">New listing</a>
    </div>
    ${problems.length ? html`<div class="warnbox"><strong>Setup needed:</strong><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}

    <div class="grid two">
      <div class="card"><h2>Needs attention</h2>
        ${issues.results.length === 0 && cancelRequests.results.length === 0 && linkRequests.results.length === 0 && unnotified.results.length === 0
          ? html`<p class="muted">Nothing to do.</p>`
          : ''}
        ${issues.results.length
          ? html`<h3>Payments (${issues.results.length})</h3>${table(['Student', 'Listing', 'Status', 'Issue', ''], issues.results.map((b) => [b.first_name, b.listing_title, bookingBadge(b.status), html`<span class="small">${b.issue ?? b.exception_reason ?? 'Checkout creation outcome unknown'}</span>`, html`<a class="btn small" href="/bookings/${b.id}">Open</a>`]))}`
          : ''}
        ${cancelRequests.results.length
          ? html`<h3>Cancellation requests (${cancelRequests.results.length})</h3>${table(['Student', 'Listing', 'Requested', ''], cancelRequests.results.map((b) => [b.first_name, b.listing_title, fmtDate(b.cancel_requested_at!), html`<a class="btn small" href="/bookings/${b.id}">Open</a>`]))}`
          : ''}
        ${linkRequests.results.length ? html`<h3>Private link requests (${linkRequests.results.length})</h3>${table(['Email', 'Requested', ''], linkRequests.results.map((r) => [r.email, fmtDate(r.created_at), html`<a class="btn small" href="/link-requests/${r.id}">Handle</a>`]))}` : ''}
        ${unnotified.results.length ? html`<h3>Schedule changes to announce</h3>${table(['Listing', 'Changes', ''], unnotified.results.map((u) => [u.title, String(u.n), html`<a class="btn small" href="/listings/${u.listing_id}">Open</a>`]))}` : ''}
      </div>
      <div class="card"><h2>At a glance</h2>
        <dl class="kv"><dt>Checkouts in progress</dt><dd class="stat">${pending?.n ?? 0}</dd><dt>Waitlist / interest</dt><dd class="stat">${waitlist?.n ?? 0}</dd></dl>
        <h3>General share link</h3>
        <p class="small muted">Opens the next bookable group, whichever it is.</p>
        <form method="post" action="/invites/share">${csrfField(ctx)}<div class="row c2"><div class="f"><label for="channel">Channel</label><select id="channel" name="channel"><option>whatsapp</option><option>instagram</option><option>discord</option><option>qr</option><option>poster</option><option>email</option><option>other</option></select></div><div class="f"><label for="code">Code <span class="hint">optional</span></label><input id="code" name="code" type="text" maxlength="32"></div></div><button type="submit" class="small">Create</button></form>
      </div>
    </div>

    <div class="card"><h2>Listings</h2>
      ${table(
        ['Listing', 'Status', 'First date (UK)', 'Seats', 'Revenue', ''],
        listings.results.map((l) => {
          const av = availabilityOf(l, counts.get(l.id), ctx.now, false);
          const r = rev.get(l.id);
          return [
            html`<a href="/listings/${l.id}"><strong>${l.title}</strong></a><br><span class="small muted">${l.lesson_count} date(s) · ${money(l.price_pence)}</span>`,
            listingBadge(l.status),
            l.first_starts_at && l.last_ends_at ? fmtSlotUk(l.first_starts_at, l.first_starts_at + 60).split(',')[0]! : '—',
            html`${av.confirmed} confirmed · ${av.held} held · ${av.left} free <span class="small muted">/ ${l.capacity}</span>`,
            r ? html`${money(r.paid - r.refunded)}${r.refunded ? html`<br><span class="small muted">after ${money(r.refunded)} refunds</span>` : ''}` : '—',
            html`<a class="btn small" href="/listings/${l.id}">Manage</a>`,
          ];
        }),
        'No listings yet. Create one to get started.',
      )}
    </div>`;
  return adminLayout(ctx, { title: 'Overview', body });
}

export async function handlePause(ctx: AdminCtx): Promise<Response> {
  const paused = field(ctx, 'paused') === '1' ? '1' : '0';
  await saveSettings(ctx.db, { bookings_paused: paused }, ctx.email, ctx.now);
  await audit(ctx.db, ctx.email, paused === '1' ? 'bookings_paused' : 'bookings_resumed', null, null, null, ctx.now);
  return back('/', { ok: paused === '1' ? 'New bookings paused. Open checkouts can still complete.' : 'Bookings resumed.' });
}

export async function handleReconcile(ctx: AdminCtx): Promise<Response> {
  try {
    const result = await reconcileStale(ctx.deps(), 40);
    await audit(ctx.db, ctx.email, 'manual_reconcile', null, null, result, ctx.now);
    const summary = Object.entries(result.results).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing needed checking';
    return back('/', { ok: `Reconciled ${result.checked} booking(s): ${summary}.` });
  } catch (e) {
    return back('/', { err: `Reconciliation failed: ${String(e).slice(0, 200)}` });
  }
}

export async function renderLinkRequest(ctx: AdminCtx, id: string): Promise<Response> {
  const req = await ctx.db.prepare('SELECT * FROM link_requests WHERE id = ?').bind(id).first<{ id: string; email: string; created_at: number; handled_at: number | null }>();
  if (!req) return back('/', { err: 'Request not found.' });
  const bookings = await ctx.db
    .prepare(`SELECT b.*, l.title AS listing_title FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.email = ? AND b.status IN ('confirmed','pending','hold','exception') ORDER BY b.created_at DESC`)
    .bind(req.email)
    .all<BookingRow & { listing_title: string }>();
  const body = html`<h1>Private link request</h1>
    <div class="card"><p><strong>${req.email}</strong> asked for their private link on ${fmtDate(req.created_at)}.</p>
    ${bookings.results.length
      ? table(['Listing', 'Status', ''], bookings.results.map((b) => [b.listing_title, bookingBadge(b.status), b.status === 'confirmed' ? postButton(ctx, `/link-requests/${req.id}/issue`, 'Issue new link & prepare email', { cls: 'primary small', fields: { booking: b.id } }) : '']))
      : html`<p class="muted">No active booking for this email. You can mark it handled (no reply needed, or reply manually).</p>`}
    <div class="actions">${postButton(ctx, `/link-requests/${req.id}/handled`, 'Mark handled')}</div></div>`;
  return adminLayout(ctx, { title: 'Link request', body });
}

export async function handleIssueForRequest(ctx: AdminCtx, id: string): Promise<Response> {
  const req = await ctx.db.prepare('SELECT * FROM link_requests WHERE id = ?').bind(id).first<{ id: string; email: string }>();
  const booking = await ctx.db.prepare(`SELECT * FROM bookings WHERE id = ? AND status = 'confirmed'`).bind(field(ctx, 'booking')).first<BookingRow>();
  if (!req || !booking || booking.email !== req.email) return back('/', { err: 'Booking does not match the request.' });
  const listing = await getListing(ctx.db, booking.listing_id);
  if (!listing) return back('/', { err: 'Listing not found.' });
  const token = await issueAccessToken(ctx.db, booking.id, 'link', ctx.email, ctx.now);
  await ctx.db.prepare('UPDATE link_requests SET handled_at = ?, handled_by = ? WHERE id = ?').bind(ctx.now, ctx.email, id).run();
  await audit(ctx.db, ctx.email, 'private_link_issued', 'booking', booking.id, { for: 'link_request' }, ctx.now);
  const message = await prepareConfirmation(ctx, booking, listing, `${ctx.cfg.publicOrigin}/b/${token}`);
  return adminLayout(ctx, { title: 'Send private link', body: html`<div class="flash">New private link created and the request marked handled. Send this email:</div>${message}` });
}

export async function handleLinkRequestHandled(ctx: AdminCtx, id: string): Promise<Response> {
  await ctx.db.prepare('UPDATE link_requests SET handled_at = ?, handled_by = ? WHERE id = ?').bind(ctx.now, ctx.email, id).run();
  return back('/', { ok: 'Request marked handled.' });
}

