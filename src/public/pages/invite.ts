import { refCookieName, signRef } from '../../shared/access';
import { looksLikeToken, sha256Hex } from '../../shared/crypto';
import { type InviteRow, getListing } from '../../shared/db';
import { html } from '../../shared/html';
import { redirect, serializeCookie } from '../../shared/http';
import { countMetric } from '../../shared/metrics';
import type { Ctx } from '../context';
import { renderHome } from './home';

export function inviteCode(invite: InviteRow): string {
  return invite.kind === 'share' ? (invite.code ?? 'share') : `invite-${invite.channel}`.slice(0, 32);
}

async function findInvite(ctx: Ctx, token: string): Promise<InviteRow | null> {
  if (/^[a-z0-9][a-z0-9-]{2,39}$/.test(token)) {
    const share = await ctx.db.prepare(`SELECT * FROM invites WHERE kind = 'share' AND code = ?`).bind(token).first<InviteRow>();
    if (share) return share;
  }
  if (looksLikeToken(token)) {
    return ctx.db
      .prepare(`SELECT * FROM invites WHERE kind = 'individual' AND token_hash = ?`)
      .bind(await sha256Hex(token))
      .first<InviteRow>();
  }
  return null;
}

/**
 * /i/<token>: a reusable outreach code or an individual invitation. Valid links record attribution in a
 * signed cookie and redirect to a clean URL (the token never stays in the address bar). Invalid, revoked
 * or expired links explain what happened and show the next bookable group instead.
 */
export async function handleInvite(ctx: Ctx, token: string): Promise<Response> {
  const invite = await findInvite(ctx, token);
  if (!invite) {
    return renderHome(ctx, { status: 404, featuredSlug: null, notice: html`This invitation link isn't valid. Here is the next available group.` });
  }
  const listing = invite.listing_id ? await getListing(ctx.db, invite.listing_id) : null;
  if (invite.revoked_at) {
    return renderHome(ctx, { status: 410, featuredSlug: null, notice: html`This invitation has been withdrawn. You can still book any open group below.` });
  }
  if (invite.expires_at && invite.expires_at <= ctx.now) {
    const featured = listing && listing.status !== 'draft' ? listing.slug : null;
    return renderHome(ctx, {
      status: 410,
      featuredSlug: featured,
      invitedOverride: false,
      notice: html`This invitation has expired. ${featured ? 'Here is that group as it stands now.' : 'Here is the next available group.'}`,
    });
  }
  if (listing && listing.status === 'draft') {
    return renderHome(ctx, { featuredSlug: null, notice: html`The group in this invitation isn't open for booking yet. Here is the next available group.` });
  }

  await ctx.db
    .prepare(
      `UPDATE invites SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, ?), last_opened_at = ? WHERE id = ?`,
    )
    .bind(ctx.now, ctx.now, invite.id)
    .run();
  ctx.exec.waitUntil(countMetric(ctx.db, 'visit', inviteCode(invite), ctx.now).catch(() => undefined));
  ctx.setCookies.push(
    serializeCookie(refCookieName(ctx.cfg), await signRef(ctx.cfg, invite.id), {
      maxAge: 30 * 86_400,
      httpOnly: true,
      secure: ctx.cfg.envName !== 'development',
      sameSite: 'Lax',
    }),
  );
  const target = listing ? `/?g=${encodeURIComponent(listing.slug)}` : '/';
  return redirect(target, { private: true });
}
