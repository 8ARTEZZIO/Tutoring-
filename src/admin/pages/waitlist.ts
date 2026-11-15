import { type ListingRow, type WaitlistRow, audit } from '../../shared/db';
import { type SafeHtml, html } from '../../shared/html';
import { fmtDate } from '../../shared/time';
import type { AdminCtx } from '../context';
import { adminLayout, back, postButton, table } from '../ui';

export async function listingWaitlistSection(ctx: AdminCtx, listing: ListingRow): Promise<SafeHtml> {
  const rows = await ctx.db
    .prepare(`SELECT * FROM waitlist WHERE listing_key = ? AND left_at IS NULL ORDER BY created_at`)
    .bind(listing.id)
    .all<WaitlistRow>();
  const general = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE listing_key = 'any' AND left_at IS NULL AND wants_seat_alert = 1`)
    .first<{ n: number }>();
  return html`<div class="card"><h2>Waitlist for this group</h2>
    <p class="small muted">${rows.results.length} on this group's list; ${general?.n ?? 0} more want any next date. The seat alert email goes to both (BCC).</p>
    ${table(
      ['Email', 'Name', 'Days', 'Seat alert', 'Weekly question', 'Joined', 'Alert sent'],
      rows.results.map((w) => [w.email, w.first_name ?? '', w.preferred_days ?? '', w.wants_seat_alert ? 'yes' : 'no', w.wants_weekly_question ? 'yes' : 'no', fmtDate(w.created_at), w.alert_sent_at ? fmtDate(w.alert_sent_at) : '—']),
      'Nobody on this list.',
    )}</div>`;
}

export async function renderWaitlistAdmin(ctx: AdminCtx): Promise<Response> {
  const settings = await ctx.settings();
  const rows = await ctx.db
    .prepare(
      `SELECT w.*, l.title AS listing_title FROM waitlist w LEFT JOIN listings l ON l.id = w.listing_key
       ORDER BY w.left_at IS NOT NULL, w.created_at DESC LIMIT 500`,
    )
    .all<WaitlistRow & { listing_title: string | null }>();
  const weekly = rows.results.filter((r) => r.wants_weekly_question && !r.left_at);
  const body = html`<h1>Waitlist and interest</h1>
    <div class="card"><h2>Retention</h2>
      <p class="small">Leads are kept for ${settings.retention_leads_days} days; unpaid checkout attempts are anonymised after ${settings.retention_unpaid_days} days. Paid bookings are kept for accounting. Change these in Settings.</p>
      ${postButton(ctx, '/retention/purge', 'Remove stale leads and anonymise old unpaid attempts now', { confirm: 'Apply the retention plan now?' })}
    </div>
    <div class="card"><h2>Weekly practice question opt-ins (${weekly.length})</h2>
      <p class="small muted">Promotional emails go only to people who ticked the weekly question box.</p>
      <div class="copy"><input id="weekly-list" type="text" readonly value="${weekly.map((w) => w.email).join(', ')}" aria-label="Opted-in emails"><button type="button" data-copy="weekly-list" hidden>Copy BCC list</button></div>
    </div>
    <div class="card"><h2>All entries</h2>
    ${table(
      ['Email', 'List', 'Days', 'Seat alert', 'Weekly', 'Joined', 'State', ''],
      rows.results.map((w) => [
        html`${w.email}${w.first_name ? html`<br><span class="small">${w.first_name}</span>` : ''}`,
        w.listing_key === 'any' ? 'Any next date' : (w.listing_title ?? w.listing_key),
        w.preferred_days ?? '',
        w.wants_seat_alert ? 'yes' : 'no',
        w.wants_weekly_question ? 'yes' : 'no',
        fmtDate(w.created_at),
        w.left_at ? `Left ${fmtDate(w.left_at)}` : w.alert_sent_at ? `Alerted ${fmtDate(w.alert_sent_at)}` : 'Waiting',
        postButton(ctx, `/waitlist/${w.id}/delete`, 'Delete', { confirm: 'Delete this entry permanently?' }),
      ]),
      'No entries yet.',
    )}</div>`;
  return adminLayout(ctx, { title: 'Waitlist', body });
}

export async function handleDeleteWaitlist(ctx: AdminCtx, id: string): Promise<Response> {
  await ctx.db.prepare('DELETE FROM waitlist WHERE id = ?').bind(id).run();
  await audit(ctx.db, ctx.email, 'waitlist_deleted', 'waitlist', id, null, ctx.now);
  return back('/waitlist', { ok: 'Entry deleted.' });
}

/** Apply the retention plan: delete stale leads, anonymise old unpaid attempts, keep accounting records. */
export async function handlePurge(ctx: AdminCtx): Promise<Response> {
  const s = await ctx.settings();
  const leadDays = Math.max(Number(s.retention_leads_days) || 180, 1);
  const unpaidDays = Math.max(Number(s.retention_unpaid_days) || 30, 1);
  const leadCutoff = ctx.now - leadDays * 86_400;
  const unpaidCutoff = ctx.now - unpaidDays * 86_400;
  const results = await ctx.db.batch([
    ctx.db.prepare('DELETE FROM waitlist WHERE (left_at IS NOT NULL AND left_at < ?) OR updated_at < ?').bind(ctx.now - 30 * 86_400, leadCutoff),
    ctx.db
      .prepare(
        `UPDATE bookings SET email = 'redacted+' || id || '@invalid', first_name = 'Redacted', cancel_request_note = NULL, redacted_at = ?
         WHERE status IN ('expired','failed') AND redacted_at IS NULL AND updated_at < ?`,
      )
      .bind(ctx.now, unpaidCutoff),
    ctx.db.prepare('DELETE FROM link_requests WHERE created_at < ?').bind(ctx.now - 90 * 86_400),
    ctx.db.prepare('DELETE FROM rate_limits WHERE win < ?').bind(ctx.now - 86_400),
  ]);
  const deleted = results[0]?.meta.changes ?? 0;
  const anonymised = results[1]?.meta.changes ?? 0;
  await audit(ctx.db, ctx.email, 'retention_purge', null, null, { deleted, anonymised }, ctx.now);
  return back('/waitlist', { ok: `Retention applied: ${deleted} lead(s) deleted, ${anonymised} unpaid attempt(s) anonymised.` });
}
