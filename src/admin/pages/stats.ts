import { type BookingRow } from '../../shared/db';
import { html } from '../../shared/html';
import { fmtDate } from '../../shared/time';
import type { AdminCtx } from '../context';
import { adminLayout, bookingBadge, table } from '../ui';

export async function renderStats(ctx: AdminCtx): Promise<Response> {
  const days = Math.min(Math.max(Number(ctx.url.searchParams.get('days')) || 30, 1), 365);
  const since = new Date((ctx.now - days * 86_400) * 1000).toISOString().slice(0, 10);
  const res = await ctx.db
    .prepare(`SELECT code, metric, SUM(count) AS n FROM daily_counts WHERE day >= ? GROUP BY code, metric`)
    .bind(since)
    .all<{ code: string; metric: string; n: number }>();
  const byCode = new Map<string, Record<string, number>>();
  for (const r of res.results) {
    const m = byCode.get(r.code) ?? {};
    m[r.metric] = r.n;
    byCode.set(r.code, m);
  }
  const rows = [...byCode.entries()].sort((a, b) => (b[1].visit ?? 0) - (a[1].visit ?? 0));
  const totals = rows.reduce(
    (t, [, m]) => ({ visit: t.visit + (m.visit ?? 0), start: t.start + (m.checkout_start ?? 0), paid: t.paid + (m.paid ?? 0), wait: t.wait + (m.waitlist_join ?? 0) }),
    { visit: 0, start: 0, paid: 0, wait: 0 },
  );
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const body = html`<h1>Outreach stats</h1>
    <p class="small muted">Aggregate first-party counts only (no cookies, no personal data). Last ${days} days. <a href="/stats?days=7">7d</a> · <a href="/stats?days=30">30d</a> · <a href="/stats?days=90">90d</a></p>
    <div class="card">${table(
      ['Outreach code', 'Visits', 'Checkout starts', 'Paid bookings', 'Waitlist joins', 'Visit → paid'],
      [
        ...rows.map(([code, m]) => [code, String(m.visit ?? 0), String(m.checkout_start ?? 0), String(m.paid ?? 0), String(m.waitlist_join ?? 0), pct(m.paid ?? 0, m.visit ?? 0)]),
        [html`<strong>Total</strong>`, String(totals.visit), String(totals.start), String(totals.paid), String(totals.wait), pct(totals.paid, totals.visit)],
      ],
      'No visits counted yet.',
    )}</div>`;
  return adminLayout(ctx, { title: 'Stats', body });
}

export async function renderIssues(ctx: AdminCtx): Promise<Response> {
  const open = await ctx.db
    .prepare(
      `SELECT b.*, l.title AS listing_title FROM bookings b JOIN listings l ON l.id = b.listing_id
       WHERE b.status IN ('hold','pending','exception') OR b.issue IS NOT NULL ORDER BY b.created_at DESC LIMIT 100`,
    )
    .all<BookingRow & { listing_title: string }>();
  const failedEvents = await ctx.db
    .prepare(`SELECT * FROM stripe_events WHERE processed_at IS NULL OR outcome IN ('unknown_booking') ORDER BY received_at DESC LIMIT 50`)
    .all<{ id: string; type: string; received_at: number; outcome: string | null; attempts: number; booking_id: string | null }>();
  const body = html`<h1>Payment issues and in-flight checkouts</h1>
    <div class="card"><h2>How states are kept honest</h2><ul class="small">
      <li><strong>Held · creating checkout</strong>: a seat is claimed and the Stripe request outcome is unknown (e.g. a lost response). The seat stays held until Stripe confirms; "Recheck" replays the exact request safely.</li>
      <li><strong>Checkout open</strong>: the student can pay until the fixed expiry (40 minutes after reserving). Seats are released only after Stripe reports the session expired unpaid.</li>
      <li><strong>Needs review</strong>: Stripe reported a payment that doesn't match the booking (amount, currency, mode) or arrived after release. Check it in Stripe, then accept or cancel and refund.</li>
      <li>The scheduled job reconciles stale checkouts every 10 minutes; you can also run it from the Overview.</li></ul></div>
    <div class="card"><h2>Bookings</h2>${table(
      ['Student', 'Listing', 'Status', 'Issue', 'Created', ''],
      open.results.map((b) => [b.first_name, b.listing_title, bookingBadge(b.status), html`<span class="small">${b.issue ?? b.exception_reason ?? ''}</span>`, fmtDate(b.created_at), html`<a class="btn small" href="/bookings/${b.id}">Open</a>`]),
      'No open payments.',
    )}</div>
    <div class="card"><h2>Webhook events not processed</h2>${table(
      ['Event', 'Type', 'Received', 'Outcome', 'Tries'],
      failedEvents.results.map((e) => [html`<span class="mono">${e.id}</span>`, e.type, fmtDate(e.received_at), e.outcome ?? 'not yet processed (Stripe will retry)', String(e.attempts)]),
      'All webhook events processed.',
    )}</div>`;
  return adminLayout(ctx, { title: 'Payment issues', body });
}

export async function renderAudit(ctx: AdminCtx): Promise<Response> {
  const rows = await ctx.db
    .prepare('SELECT * FROM admin_actions ORDER BY at DESC, id DESC LIMIT 300')
    .all<{ id: number; at: number; actor: string; action: string; entity_type: string | null; entity_id: string | null; details: string | null }>();
  const body = html`<h1>Audit log</h1><div class="card">${table(
    ['When', 'Who', 'Action', 'Entity', 'Details'],
    rows.results.map((r) => [
      `${fmtDate(r.at)} ${new Date(r.at * 1000).toISOString().slice(11, 16)} UTC`,
      r.actor,
      r.action,
      r.entity_type === 'booking' && r.entity_id ? html`<a href="/bookings/${r.entity_id}">${r.entity_id}</a>` : r.entity_type === 'listing' && r.entity_id ? html`<a href="/listings/${r.entity_id}">${r.entity_id}</a>` : (r.entity_id ?? ''),
      html`<span class="small mono">${(r.details ?? '').slice(0, 300)}</span>`,
    ]),
    'No actions yet.',
  )}</div>`;
  return adminLayout(ctx, { title: 'Audit log', body });
}
