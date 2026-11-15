import { looksLikeToken, randomId, randomToken, sha256Hex } from '../../shared/crypto';
import { type ListingRow, type WaitlistRow, getListingBySlug } from '../../shared/db';
import { cleanCode, cleanName, isValidEmail, normaliseEmail } from '../../shared/format';
import { html } from '../../shared/html';
import { isSameOrigin, readForm } from '../../shared/http';
import { countMetric, rateLimit } from '../../shared/metrics';
import { WEEKDAYS_SHORT } from '../../shared/time';
import { verifyTurnstile } from '../../shared/turnstile';
import { turnstileWidget } from '../../shared/ui/public';
import type { Ctx } from '../context';
import { messagePage } from './misc';

interface WaitValues {
  email: string;
  first_name: string;
  days: string[];
  seat_alert: boolean;
  weekly: boolean;
}

async function targetListing(ctx: Ctx, slug: string | null): Promise<ListingRow | null> {
  if (!slug) return null;
  const l = await getListingBySlug(ctx.db, slug);
  return l && (l.status === 'published' || l.status === 'closed') ? l : null;
}

export async function renderWaitlist(
  ctx: Ctx,
  opts: { slug?: string | null; values?: Partial<WaitValues>; error?: string; status?: number } = {},
): Promise<Response> {
  const slug = opts.slug ?? ctx.url.searchParams.get('l');
  const listing = await targetListing(ctx, slug);
  const v = opts.values ?? {};
  const seat = v.seat_alert ?? true;
  const title = listing ? `Join the waitlist: ${listing.title}` : 'Get the next date';
  return messagePage(ctx, {
    title,
    status: opts.status,
    private: true,
    turnstile: true,
    body: html`<h1>${title}</h1>
      <p>${listing ? "You'll get one email if a seat opens on this group." : "You'll get an email when the next date is published."} Your email is only used for what you tick below.</p>
      ${opts.error ? html`<div class="error-box" role="alert">${opts.error}</div>` : ''}
      <form method="post" action="/waitlist" data-once>
        <input type="hidden" name="l" value="${listing?.slug ?? ''}">
        <input type="hidden" name="ref" value="${cleanCode(ctx.url.searchParams.get('ref'))}">
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${v.email ?? ''}"></div>
        <div class="field"><label for="first_name">First name <span class="hint">Optional</span></label><input id="first_name" name="first_name" type="text" autocomplete="given-name" maxlength="60" value="${v.first_name ?? ''}"></div>
        <fieldset><legend>Preferred days <span class="hint">Optional</span></legend>
          <div class="days">${WEEKDAYS_SHORT.map((d) => html`<label><input type="checkbox" name="days" value="${d}" ${v.days?.includes(d) ? 'checked' : ''}> ${d}</label>`)}</div>
        </fieldset>
        <label class="check"><input type="checkbox" name="seat_alert" value="1" ${seat ? 'checked' : ''}> <span>${listing ? 'Email me if a seat opens on this group.' : 'Email me when a new date is published.'}</span></label>
        <label class="check"><input type="checkbox" name="weekly" value="1" ${v.weekly ? 'checked' : ''}> <span>Also send me a free weekly Python practice question. <span class="hint">Optional. Unsubscribe any time.</span></span></label>
        ${turnstileWidget(ctx.cfg, 'waitlist')}
        <button class="btn btn-primary" type="submit">${listing ? 'Join the waitlist' : 'Get the next date'}</button>
      </form>
      <p class="small"><a href="/privacy">How your email is used</a></p>`,
  });
}

export async function handleWaitlistPost(ctx: Ctx): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return renderWaitlist(ctx, { error: 'Please use the form on this site.', status: 403 });
  const form = await readForm(ctx.req);
  if (!form) return renderWaitlist(ctx, { error: 'Please try again.', status: 400 });
  const slug = form.get('l') || null;
  const values: WaitValues = {
    email: normaliseEmail(form.get('email') ?? ''),
    first_name: cleanName(form.get('first_name') ?? ''),
    days: form.getAll('days').filter((d) => WEEKDAYS_SHORT.includes(d)),
    seat_alert: form.get('seat_alert') === '1',
    weekly: form.get('weekly') === '1',
  };
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'waitlist', 10, 3600, ctx.now))) {
    return renderWaitlist(ctx, { slug, values, error: 'Too many requests. Please try again later.', status: 429 });
  }
  if (!isValidEmail(values.email)) return renderWaitlist(ctx, { slug, values, error: 'Enter a valid email address.', status: 422 });
  if (!values.seat_alert && !values.weekly) {
    return renderWaitlist(ctx, { slug, values, error: 'Tick at least one option so we know what to send you.', status: 422 });
  }
  const captcha = await verifyTurnstile(ctx.cfg, form.get('cf-turnstile-response'), ctx.ip);
  if (!captcha.ok) return renderWaitlist(ctx, { slug, values, error: 'Please complete the "I am human" check.', status: 422 });
  const listing = await targetListing(ctx, slug);
  const key = listing?.id ?? 'any';
  const leaveToken = randomToken(32);
  await ctx.db
    .prepare(
      `INSERT INTO waitlist (id, listing_key, email, first_name, preferred_days, wants_seat_alert, wants_weekly_question,
         leave_token_hash, source_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(listing_key, email) DO UPDATE SET
         first_name = COALESCE(excluded.first_name, waitlist.first_name),
         preferred_days = excluded.preferred_days,
         wants_seat_alert = excluded.wants_seat_alert,
         wants_weekly_question = excluded.wants_weekly_question,
         leave_token_hash = excluded.leave_token_hash,
         left_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      randomId('wl'),
      key,
      values.email,
      values.first_name || null,
      values.days.join(',') || null,
      values.seat_alert ? 1 : 0,
      values.weekly ? 1 : 0,
      await sha256Hex(leaveToken),
      cleanCode(form.get('ref')),
      ctx.now,
      ctx.now,
    )
    .run();
  ctx.exec.waitUntil(countMetric(ctx.db, 'waitlist_join', cleanCode(form.get('ref')), ctx.now).catch(() => undefined));
  const leave = `${ctx.cfg.publicOrigin}/waitlist/leave/${leaveToken}`;
  return messagePage(ctx, {
    title: "You're on the list",
    private: true,
    body: html`<h1>You're on the list</h1>
      <div class="state state-confirmed" role="status"><p>${listing ? html`We'll email <strong>${values.email}</strong> if a seat opens on ${listing.title}.` : html`We'll email <strong>${values.email}</strong> when the next date is published.`}${values.weekly ? ' You also asked for the weekly practice question.' : ''}</p></div>
      <p class="small">Changed your mind? You can <a href="${leave}">leave the list</a> at any time; you can also bookmark that link.</p>
      <div class="actions"><a class="btn btn-secondary" href="/calendar">See the calendar</a></div>`,
  });
}

async function findByLeaveToken(ctx: Ctx, token: string): Promise<WaitlistRow | null> {
  if (!looksLikeToken(token)) return null;
  return ctx.db.prepare('SELECT * FROM waitlist WHERE leave_token_hash = ?').bind(await sha256Hex(token)).first<WaitlistRow>();
}

export async function renderLeave(ctx: Ctx, token: string): Promise<Response> {
  const row = await findByLeaveToken(ctx, token);
  if (!row) return messagePage(ctx, { title: 'Link not valid', status: 404, private: true, body: html`<h1>This link isn't valid</h1><p>Reply to any email you received and you'll be removed.</p>` });
  if (row.left_at) return messagePage(ctx, { title: 'Left the list', private: true, body: html`<h1>You've already left this list</h1>` });
  return messagePage(ctx, {
    title: 'Leave the list',
    private: true,
    body: html`<h1>Leave the waitlist?</h1><p>You'll stop getting seat alerts${row.wants_weekly_question ? ' and the weekly practice question' : ''} for this list.</p>
      <form method="post" action="/waitlist/leave/${token}"><button class="btn btn-primary" type="submit">Leave the list</button></form>`,
  });
}

export async function handleLeave(ctx: Ctx, token: string): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return messagePage(ctx, { title: 'Not allowed', status: 403, private: true, body: html`<h1>Not allowed</h1>` });
  const row = await findByLeaveToken(ctx, token);
  if (row) {
    await ctx.db
      .prepare('UPDATE waitlist SET left_at = ?, wants_seat_alert = 0, wants_weekly_question = 0, updated_at = ? WHERE id = ?')
      .bind(ctx.now, ctx.now, row.id)
      .run();
  }
  return messagePage(ctx, { title: 'Left the list', private: true, body: html`<h1>You've left the list</h1><p>You won't get any more emails from this list.</p>` });
}
