import { revokeAccessTokens } from '../../shared/access';
import { cancelSeat, reconcileBooking, releaseIfFullyRefunded, syncRefunds } from '../../shared/booking';
import { type BookingRow, type RefundRow, audit, getBooking, getListing } from '../../shared/db';
import { cleanText } from '../../shared/format';
import { html } from '../../shared/html';
import { StripeError } from '../../shared/stripe';
import { fmtDate, fmtSlotUk } from '../../shared/time';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, bookingBadge, csrfField, money, postButton, stripeDashboardUrl, table } from '../ui';

export async function loadBooking(ctx: AdminCtx, id: string): Promise<BookingRow | null> {
  return /^bk_[a-z0-9]{16}$/.test(id) ? getBooking(ctx.db, id) : null;
}

export async function renderBookingAdmin(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  const listing = await getListing(ctx.db, booking.listing_id);
  const refunds = await ctx.db.prepare('SELECT * FROM refunds WHERE booking_id = ? ORDER BY stripe_created_at').bind(booking.id).all<RefundRow>();
  const tokens = await ctx.db
    .prepare('SELECT kind, created_at, created_by, last_used_at, revoked_at FROM access_tokens WHERE booking_id = ? ORDER BY created_at')
    .bind(booking.id)
    .all<{ kind: string; created_at: number; created_by: string; last_used_at: number | null; revoked_at: number | null }>();
  const events = await ctx.db
    .prepare('SELECT * FROM stripe_events WHERE booking_id = ? ORDER BY received_at DESC LIMIT 20')
    .bind(booking.id)
    .all<{ id: string; type: string; received_at: number; processed_at: number | null; outcome: string | null; attempts: number }>();
  const history = await ctx.db
    .prepare(`SELECT * FROM admin_actions WHERE entity_type = 'booking' AND entity_id = ? ORDER BY at DESC LIMIT 30`)
    .bind(booking.id)
    .all<{ at: number; actor: string; action: string; details: string | null }>();
  const messages = await ctx.db
    .prepare('SELECT template, marked_sent_at, actor FROM messages WHERE booking_id = ? ORDER BY marked_sent_at DESC')
    .bind(booking.id)
    .all<{ template: string; marked_sent_at: number; actor: string }>();
  const activeLinks = tokens.results.filter((t) => !t.revoked_at).length;
  const isUncertain = booking.status === 'hold' || Boolean(booking.issue);

  const body = html`<p><a href="/listings/${booking.listing_id}">← ${listing?.title ?? 'Listing'}</a></p>
    <h1>${booking.first_name} · ${bookingBadge(booking.status)}</h1>
    ${booking.issue ? html`<div class="warnbox"><strong>Needs attention:</strong> ${booking.issue}</div>` : ''}
    ${booking.exception_reason ? html`<div class="flash err"><strong>Payment exception:</strong> ${booking.exception_reason}</div>` : ''}
    ${booking.cancel_requested_at && !booking.cancel_request_handled_at
      ? html`<div class="warnbox"><strong>Cancellation requested</strong> on ${fmtDate(booking.cancel_requested_at)}${booking.cancel_request_note ? html`: “${booking.cancel_request_note}”` : ''}.
          Refund in the Stripe Dashboard if due, then sync refunds and/or cancel the seat. ${postButton(ctx, `/bookings/${booking.id}/cancel-request-handled`, 'Mark request handled')}</div>`
      : ''}
    <div class="grid two">
      <div class="card"><h2>Booking</h2><dl class="kv">
        <dt>Reference</dt><dd class="mono">${booking.id}</dd>
        <dt>Email</dt><dd>${booking.email}</dd>
        <dt>Listing</dt><dd>${listing?.title ?? booking.listing_id}</dd>
        <dt>Price snapshot</dt><dd>${money(booking.price_pence)}</dd>
        <dt>Paid</dt><dd>${money(booking.amount_paid_pence)}${booking.payment_reference ? html` · ref ${booking.payment_reference}` : ''}</dd>
        <dt>Refunded</dt><dd>${money(booking.refunded_pence)} (${booking.refund_state})${booking.refund_pending_pence ? html` · ${money(booking.refund_pending_pence)} pending` : ''}</dd>
        <dt>Source</dt><dd>${booking.source} · ${booking.source_code}</dd>
        <dt>Terms</dt><dd>v${booking.terms_version}${booking.early_start_requested ? html` · early start requested & acknowledged (wording v${booking.early_start_text_version ?? '?'})` : ''}</dd>
        <dt>Created</dt><dd>${fmtDate(booking.created_at)}</dd>
        <dt>Confirmed</dt><dd>${booking.confirmed_at ? fmtDate(booking.confirmed_at) : '—'}</dd>
        <dt>Checkout</dt><dd>${booking.checkout_session_id ? html`<a class="mono" href="${stripeDashboardUrl(ctx, 'checkout', booking.checkout_session_id)}" target="_blank" rel="noopener noreferrer">${booking.checkout_session_id}</a>` : '—'} · attempts ${booking.checkout_attempts}${booking.checkout_expires_at ? html` · expires ${fmtSlotUk(booking.checkout_expires_at, booking.checkout_expires_at + 60).split(',')[1]}` : ''}</dd>
        <dt>Payment</dt><dd>${booking.payment_intent_id ? html`<a class="mono" href="${stripeDashboardUrl(ctx, 'payments', booking.payment_intent_id)}" target="_blank" rel="noopener noreferrer">${booking.payment_intent_id}</a>` : '—'}</dd>
        ${booking.last_checkout_error ? html`<dt>Last error</dt><dd class="small">${booking.last_checkout_error}</dd>` : ''}
      </dl></div>
      <div class="card"><h2>Actions</h2>
        <div class="actions">
          ${postButton(ctx, `/bookings/${booking.id}/recheck`, 'Recheck payment with Stripe', { cls: 'primary' })}
          ${booking.payment_intent_id ? postButton(ctx, `/bookings/${booking.id}/sync-refunds`, 'Sync refunds from Stripe') : ''}
        </div>
        ${booking.status === 'confirmed'
          ? html`<h3>Private access</h3><p class="small">${activeLinks} active link/device token(s).</p><div class="actions">
              ${postButton(ctx, '/messages/prepare', 'Prepare confirmation email (new private link)', { fields: { template: 'confirmation', booking: booking.id } })}
              ${booking.refunded_pence ? postButton(ctx, '/messages/prepare', 'Prepare refund email', { fields: { template: 'refund', booking: booking.id } }) : ''}
              ${activeLinks ? postButton(ctx, `/bookings/${booking.id}/revoke-links`, 'Revoke all private links', { cls: 'danger small', confirm: 'Revoke every private link and device for this booking?' }) : ''}
            </div>`
          : ''}
        ${booking.status === 'exception'
          ? html`<h3>Resolve exception</h3><p class="small">Check the payment in Stripe first. Accepting confirms the seat as-is.</p>
              ${postButton(ctx, `/bookings/${booking.id}/accept-exception`, 'Accept payment and confirm seat', { confirm: 'Confirm this seat after checking Stripe?' })}`
          : ''}
        ${booking.status === 'confirmed' && booking.refund_state === 'full'
          ? html`<h3>Fully refunded</h3>${postButton(ctx, `/bookings/${booking.id}/release-refunded`, 'Verify refund in Stripe and release seat', { cls: 'primary' })}`
          : ''}
        ${['confirmed', 'exception', 'hold', 'pending'].includes(booking.status)
          ? html`<h3>Cancel seat</h3><p class="small">Releases the seat. Refunds are separate: issue them in the Stripe Dashboard.</p>
              <form method="post" action="/bookings/${booking.id}/cancel-seat" data-confirm="Cancel this seat?">${csrfField(ctx)}
                <div class="f"><label for="reason">Reason</label><input id="reason" name="reason" type="text" maxlength="200" required></div>
                <button class="danger small" type="submit">Cancel seat</button></form>`
          : ''}
        ${isUncertain
          ? html`<h3>Stripe recovery procedure</h3><ol class="small">
              <li>Press <em>Recheck payment with Stripe</em>. It replays the exact original request safely (same idempotency key) or looks the session up.</li>
              <li>If still unresolved, open the Stripe Dashboard (${ctx.cfg.stripe.livemode ? 'live' : 'test'} mode) → Payments, and search for <code>${booking.id}</code> (it is in the payment description and metadata).</li>
              <li>If a payment exists, recheck again after a minute; if none exists after the checkout expiry, the seat is released automatically.</li></ol>`
          : ''}
      </div>
    </div>
    <div class="card"><h2>Refund history (from Stripe)</h2>
      ${table(['Refund', 'Amount', 'Status', 'Reason', 'Created'], refunds.results.map((r) => [html`<span class="mono">${r.id}</span>`, money(r.amount_pence), r.status, r.reason ?? '', fmtDate(r.stripe_created_at)]), 'No refunds recorded.')}
      <p class="small muted">Process refunds in the Stripe Dashboard; this list updates from Stripe webhooks or "Sync refunds".</p>
    </div>
    <div class="grid two">
      <div class="card"><h2>Webhook events</h2>${table(['Type', 'Received', 'Outcome', 'Tries'], events.results.map((e) => [e.type, fmtDate(e.received_at), e.outcome ?? 'processing', String(e.attempts)]), 'None.')}</div>
      <div class="card"><h2>Emails marked sent</h2>${table(['Template', 'When', 'By'], messages.results.map((m) => [m.template, fmtDate(m.marked_sent_at), m.actor]), 'None yet.')}</div>
    </div>
    <div class="card"><h2>Private access tokens</h2>${table(['Kind', 'Created', 'By', 'Last used', 'Revoked'], tokens.results.map((t) => [t.kind, fmtDate(t.created_at), t.created_by, t.last_used_at ? fmtDate(t.last_used_at) : '—', t.revoked_at ? fmtDate(t.revoked_at) : '—']), 'None.')}</div>
    <div class="card"><h2>History</h2>${table(['When', 'Who', 'Action', 'Details'], history.results.map((h) => [fmtDate(h.at), h.actor, h.action, html`<span class="small mono">${h.details ?? ''}</span>`]), 'No history.')}</div>`;
  return adminLayout(ctx, { title: `Booking ${booking.id}`, body });
}

export async function handleRecheck(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  try {
    const outcome = await reconcileBooking(ctx.deps(), booking, 'admin');
    let refunds = '';
    const fresh = outcome.booking;
    if (fresh.payment_intent_id) {
      const synced = await syncRefunds(ctx.deps(), fresh);
      refunds = ` Refunds: ${synced.refund_state}.`;
    }
    await audit(ctx.db, ctx.email, 'payment_rechecked', 'booking', booking.id, { result: outcome.kind }, ctx.now);
    return back(`/bookings/${booking.id}`, { ok: `Rechecked with Stripe: ${outcome.kind} (status ${fresh.status}).${refunds}` });
  } catch (e) {
    const msg = e instanceof StripeError ? e.message : String(e);
    return back(`/bookings/${booking.id}`, { err: `Stripe check failed: ${msg.slice(0, 200)}` });
  }
}

export async function handleSyncRefunds(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  try {
    const fresh = await syncRefunds(ctx.deps(), booking);
    return back(`/bookings/${booking.id}`, { ok: `Refunds synced: ${fresh.refund_state}, £${(fresh.refunded_pence / 100).toFixed(2)} refunded.` });
  } catch (e) {
    return back(`/bookings/${booking.id}`, { err: `Could not reach Stripe: ${String(e).slice(0, 160)}` });
  }
}

export async function handleReleaseRefunded(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  try {
    const r = await releaseIfFullyRefunded(ctx.deps(), booking, ctx.email);
    return back(`/bookings/${booking.id}`, r.ok ? { ok: r.message } : { err: r.message });
  } catch (e) {
    return back(`/bookings/${booking.id}`, { err: `Could not verify with Stripe: ${String(e).slice(0, 160)}` });
  }
}

export async function handleCancelSeat(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  const reason = cleanText(field(ctx, 'reason'), 200);
  const r = await cancelSeat(ctx.deps(), booking, ctx.email, reason);
  return back(`/bookings/${booking.id}`, r.ok ? { ok: r.message } : { err: r.message });
}

export async function handleRevokeLinks(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  const n = await revokeAccessTokens(ctx.db, booking.id, ctx.now);
  await audit(ctx.db, ctx.email, 'private_links_revoked', 'booking', booking.id, { count: n }, ctx.now);
  return back(`/bookings/${booking.id}`, { ok: `Revoked ${n} private link(s)/device(s). Issue a new link from the confirmation email action.` });
}

export async function handleAcceptException(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  if (booking.status !== 'exception') return back(`/bookings/${booking.id}`, { err: 'Not an exception.' });
  await ctx.db
    .prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), issue = NULL, updated_at = ? WHERE id = ? AND status = 'exception'`)
    .bind(ctx.now, ctx.now, booking.id)
    .run();
  await audit(ctx.db, ctx.email, 'exception_accepted', 'booking', booking.id, { reason: booking.exception_reason }, ctx.now);
  return back(`/bookings/${booking.id}`, { ok: 'Seat confirmed after manual review.' });
}

export async function handleCancelRequestHandled(ctx: AdminCtx, booking: BookingRow): Promise<Response> {
  await ctx.db.prepare('UPDATE bookings SET cancel_request_handled_at = ?, updated_at = ? WHERE id = ?').bind(ctx.now, ctx.now, booking.id).run();
  await audit(ctx.db, ctx.email, 'cancel_request_handled', 'booking', booking.id, null, ctx.now);
  return back(`/bookings/${booking.id}`, { ok: 'Cancellation request marked handled.' });
}
