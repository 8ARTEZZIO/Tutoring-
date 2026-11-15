import { randomCode, randomId, randomToken, sha256Hex } from '../../shared/crypto';
import { type InviteRow, type ListingRow, audit } from '../../shared/db';
import { cleanText } from '../../shared/format';
import { type SafeHtml, html } from '../../shared/html';
import { fmtDate, ukLocalToUtc } from '../../shared/time';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, csrfField, postButton, table } from '../ui';

const CHANNELS = ['whatsapp', 'instagram', 'discord', 'email', 'qr', 'poster', 'friend', 'other'];

type Stats = Map<string, Record<string, number>>;

async function inviteStats(db: D1Database, ids: string[]): Promise<Stats> {
  const map: Stats = new Map();
  if (!ids.length) return map;
  const res = await db
    .prepare(`SELECT invite_id, status, COUNT(*) AS n FROM bookings WHERE invite_id IN (${ids.map(() => '?').join(',')}) GROUP BY invite_id, status`)
    .bind(...ids)
    .all<{ invite_id: string; status: string; n: number }>();
  for (const r of res.results) {
    const m = map.get(r.invite_id) ?? {};
    m[r.status] = r.n;
    map.set(r.invite_id, m);
  }
  return map;
}

function inviteState(ctx: AdminCtx, inv: InviteRow, stats: Record<string, number> | undefined): SafeHtml {
  if (inv.revoked_at) return html`<span class="badge b-idle">Revoked</span>`;
  if (inv.expires_at && inv.expires_at <= ctx.now) return html`<span class="badge b-idle">Expired</span>`;
  if (inv.kind === 'individual') {
    if (stats?.confirmed) return html`<span class="badge b-ok">Confirmed</span>`;
    if (stats?.pending || stats?.hold) return html`<span class="badge b-warn">Checkout started</span>`;
    if (inv.first_opened_at) return html`<span class="badge b-lime">Opened · not paid</span>`;
    return html`<span class="badge b-idle">Assigned · not opened</span>`;
  }
  return html`<span class="badge b-ok">Active</span>`;
}

export async function invitesSection(ctx: AdminCtx, listing: ListingRow): Promise<SafeHtml> {
  const res = await ctx.db.prepare('SELECT * FROM invites WHERE listing_id = ? ORDER BY created_at DESC').bind(listing.id).all<InviteRow>();
  const stats = await inviteStats(ctx.db, res.results.map((i) => i.id));
  const shares = res.results.filter((i) => i.kind === 'share');
  const individuals = res.results.filter((i) => i.kind === 'individual');
  const total = (s: Record<string, number> | undefined) => Object.values(s ?? {}).reduce((a, b) => a + b, 0);
  return html`<div class="card"><h2>Share links and invitations</h2>
    <div class="grid two">
      <div>
        <h3>Reusable share link (per channel)</h3>
        <form method="post" action="/listings/${listing.id}/share-links">${csrfField(ctx)}
          <div class="row c3">
            <div class="f"><label for="channel">Channel</label><select id="channel" name="channel">${CHANNELS.map((c) => html`<option value="${c}">${c}</option>`)}</select></div>
            <div class="f"><label for="code">Code <span class="hint">optional</span></label><input id="code" name="code" type="text" maxlength="32" placeholder="auto"></div>
            <div class="f"><label for="expires">Expires <span class="hint">optional</span></label><input id="expires" name="expires" type="date"></div>
          </div>
          <button type="submit">Create share link</button>
        </form>
      </div>
      <div>
        <h3>Individual invitation (expiring)</h3>
        <form method="post" action="/listings/${listing.id}/invites">${csrfField(ctx)}
          <div class="row c2">
            <div class="f"><label for="note">Private note <span class="hint">only you see this</span></label><input id="note" name="note" type="text" maxlength="120" placeholder="e.g. referred by tutor group"></div>
            <div class="f"><label for="days">Valid for (days)</label><input id="days" name="days" type="number" min="1" max="60" value="7"></div>
          </div>
          <button type="submit">Create invitation</button>
        </form>
      </div>
    </div>
    <h3>Share links</h3>
    ${table(
      ['Link', 'Channel', 'Opens', 'Checkouts', 'Confirmed', 'Expires', 'State', ''],
      shares.map((s) => {
        const url = `${ctx.cfg.publicOrigin}/i/${s.code}`;
        return [
          html`<div class="copy"><input id="sh-${s.id}" type="text" readonly value="${url}" aria-label="Share link"><button type="button" class="small" data-copy="sh-${s.id}" hidden>Copy</button></div>`,
          s.channel,
          String(s.open_count),
          String(total(stats.get(s.id))),
          String(stats.get(s.id)?.confirmed ?? 0),
          s.expires_at ? fmtDate(s.expires_at) : 'never',
          inviteState(ctx, s, stats.get(s.id)),
          s.revoked_at ? '' : postButton(ctx, `/invites/${s.id}/revoke`, 'Revoke', { confirm: 'Revoke this link?' }),
        ];
      }),
      'No share links yet.',
    )}
    <h3>Individual invitations</h3>
    ${table(
      ['Note', 'Created', 'Expires', 'Opened', 'Status', ''],
      individuals.map((i) => [
        i.note ?? '—',
        fmtDate(i.created_at),
        i.expires_at ? fmtDate(i.expires_at) : 'never',
        i.first_opened_at ? fmtDate(i.first_opened_at) : 'no',
        inviteState(ctx, i, stats.get(i.id)),
        i.revoked_at ? '' : postButton(ctx, `/invites/${i.id}/revoke`, 'Revoke', { confirm: 'Revoke this invitation?' }),
      ]),
      'No invitations yet.',
    )}
    <p class="small muted">Invitation links are shown once when created (only a hash is stored). Create a new one if it's lost.</p>
  </div>`;
}

function expiryFromDate(value: string): number | null {
  if (!value) return null;
  const r = ukLocalToUtc(value, '23:59');
  return r.ok ? r.ts : null;
}

export async function handleCreateShare(ctx: AdminCtx, listing: ListingRow | null): Promise<Response> {
  const channel = CHANNELS.includes(field(ctx, 'channel')) ? field(ctx, 'channel') : 'other';
  const custom = field(ctx, 'code').toLowerCase();
  if (custom && !/^[a-z0-9][a-z0-9-]{2,31}$/.test(custom)) {
    return back(listing ? `/listings/${listing.id}` : '/', { err: 'Codes are 3-32 lowercase letters, numbers or dashes.' });
  }
  const code = custom || `${channel}-${randomCode(5)}`;
  const exists = await ctx.db.prepare('SELECT id FROM invites WHERE code = ?').bind(code).first();
  if (exists) return back(listing ? `/listings/${listing.id}` : '/', { err: 'That code is already used.' });
  const id = randomId('inv', 12);
  await ctx.db
    .prepare(`INSERT INTO invites (id, kind, listing_id, code, channel, expires_at, created_at, created_by) VALUES (?, 'share', ?, ?, ?, ?, ?, ?)`)
    .bind(id, listing?.id ?? null, code, channel, expiryFromDate(field(ctx, 'expires')), ctx.now, ctx.email)
    .run();
  await audit(ctx.db, ctx.email, 'share_link_created', 'invite', id, { code, channel, listing: listing?.id ?? null }, ctx.now);
  return back(listing ? `/listings/${listing.id}` : '/', { ok: `Share link created: ${ctx.cfg.publicOrigin}/i/${code}` });
}

export async function handleCreateInvite(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const days = Math.min(Math.max(Number(field(ctx, 'days')) || 7, 1), 60);
  const token = randomToken(32);
  const id = randomId('inv', 12);
  await ctx.db
    .prepare(`INSERT INTO invites (id, kind, listing_id, token_hash, channel, note, expires_at, created_at, created_by) VALUES (?, 'individual', ?, ?, 'direct', ?, ?, ?, ?)`)
    .bind(id, listing.id, await sha256Hex(token), cleanText(field(ctx, 'note'), 120) || null, ctx.now + days * 86_400, ctx.now, ctx.email)
    .run();
  await audit(ctx.db, ctx.email, 'invite_created', 'invite', id, { listing: listing.id, days }, ctx.now);
  const url = `${ctx.cfg.publicOrigin}/i/${token}`;
  return adminLayout(ctx, {
    title: 'Invitation created',
    body: html`<h1>Invitation created</h1>
      <div class="card"><p>Send this link to the student. It opens <strong>${listing.title}</strong> with checkout ready, expires in ${days} day(s), and is shown only now.</p>
      <div class="copy"><input id="invite-url" type="text" readonly value="${url}" aria-label="Invitation link"><button type="button" data-copy="invite-url" hidden>Copy</button></div>
      <p><a href="/listings/${listing.id}">Back to the listing</a></p></div>`,
  });
}

export async function handleRevokeInvite(ctx: AdminCtx, id: string): Promise<Response> {
  const inv = await ctx.db.prepare('SELECT * FROM invites WHERE id = ?').bind(id).first<InviteRow>();
  if (!inv) return back('/', { err: 'Invitation not found.' });
  await ctx.db.prepare('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').bind(ctx.now, id).run();
  await audit(ctx.db, ctx.email, 'invite_revoked', 'invite', id, null, ctx.now);
  return back(inv.listing_id ? `/listings/${inv.listing_id}` : '/', { ok: 'Link revoked.' });
}
