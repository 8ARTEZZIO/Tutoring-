import {
  accessCookie,
  bookingFormToken,
  checkBookingFormToken,
  issueAccessToken,
  lookupToken,
  readCookieTokens,
} from '../../shared/access';
import { randomId } from '../../shared/crypto';
import { type BookingRow, type LessonRow, type ListingRow, getAllLessons, getListing } from '../../shared/db';
import { cleanText, fmtMoney, isValidEmail, normaliseEmail } from '../../shared/format';
import { type SafeHtml, html, paragraphs } from '../../shared/html';
import { buildIcs } from '../../shared/ics';
import { isSameOrigin, privateHeaders, readForm, redirect } from '../../shared/http';
import { rateLimit } from '../../shared/metrics';
import { fmtDate } from '../../shared/time';
import { verifyTurnstile } from '../../shared/turnstile';
import { dateList, turnstileWidget } from '../../shared/ui/public';
import type { Ctx } from '../context';
import { messagePage } from './misc';

const BOOKING_ID = /^bk_[a-z0-9]{16}$/;

/** /b/<token>: validate, store in an HttpOnly cookie, then redirect so the token leaves the URL. */
export async function handleLinkExchange(ctx: Ctx, token: string): Promise<Response> {
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'link', 30, 600, ctx.now))) {
    return messagePage(ctx, { title: 'Too many attempts', status: 429, private: true, body: html`<h1>Too many attempts</h1><p>Please wait a few minutes.</p>` });
  }
  const row = await lookupToken(ctx.db, token);
  if (!row) {
    return messagePage(ctx, {
      title: 'Link not valid',
      status: 404,
      private: true,
      body: html`<h1>This booking link isn't valid any more</h1><p>It may have been replaced by a newer link. <a href="/booking/recover">Ask for a new private link</a>.</p>`,
    });
  }
  await ctx.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?').bind(ctx.now, row.token_hash).run();
  ctx.setCookies.push(accessCookie(ctx.cfg, [token, ...readCookieTokens(ctx.cookies, ctx.cfg)]));
  return redirect(`/booking/${row.booking_id}`, { private: true });
}

function statusBlock(b: BookingRow, listing: ListingRow, welcome: boolean): SafeHtml {
  if (listing.status === 'cancelled' && (b.status === 'confirmed' || b.status === 'cancelled')) {
    return html`<div class="state state-cancelled" role="status"><h2>This group has been cancelled</h2><p>${listing.cancel_reason ?? ''} You'll get a full refund for sessions that haven't taken place${b.refunded_pence > 0 ? html` (${fmtMoney(b.refunded_pence, b.currency)} refunded so far)` : ''}.</p></div>`;
  }
  switch (b.status) {
    case 'confirmed':
      return html`<div class="state state-confirmed" role="status"><h2>${welcome ? "You're booked!" : 'Confirmed'}</h2><p>Your payment of ${fmtMoney(b.amount_paid_pence ?? b.price_pence, b.currency)} is verified and your seat is confirmed${listing.lesson_count > 1 ? ` for all ${listing.lesson_count} dates` : ''}.${b.refunded_pence > 0 ? html` ${fmtMoney(b.refunded_pence, b.currency)} has been refunded.` : ''}</p></div>`;
    case 'pending':
    case 'hold':
      return html`<div class="state state-pending" role="status"><h2>Payment pending</h2><p>Your seat is held while payment is confirmed. Call links appear here once Stripe verifies your payment.</p><div class="actions"><a class="btn btn-primary" href="/checkout/resume?b=${b.id}">Continue to payment</a></div></div>`;
    case 'exception':
      return html`<div class="state state-pending" role="status"><h2>Being checked</h2><p>Your payment needs a quick manual check. Your seat is kept; you don't need to pay again.</p></div>`;
    case 'cancelled':
      return html`<div class="state state-cancelled" role="status"><h2>Cancelled</h2><p>This booking has been cancelled${b.refunded_pence > 0 ? html` and ${fmtMoney(b.refunded_pence, b.currency)} refunded` : ''}.</p></div>`;
    default:
      return html`<div class="state state-cancelled" role="status"><h2>Not booked</h2><p>This checkout ended without payment, so nothing was charged. <a href="/session/${listing.slug}">Book again</a></p></div>`;
  }
}

export async function renderBookingIndex(ctx: Ctx): Promise<Response> {
  const grants = await ctx.access();
  if (grants.size === 0) {
    return messagePage(ctx, {
      title: 'My booking',
      private: true,
      body: html`<h1>My booking</h1><div class="state state-empty"><p>No bookings are saved on this device.</p></div>
        <ul><li>Open the private link from your confirmation email on this device.</li><li>Or <a href="/booking/recover">ask for your private link</a>.</li></ul>`,
    });
  }
  const rows = [...grants.values()].map((g) => g.booking).sort((a, b) => b.created_at - a.created_at);
  if (rows.length === 1) return redirect(`/booking/${rows[0]!.id}`, { private: true });
  const listings = new Map<string, ListingRow>();
  for (const b of rows) {
    if (!listings.has(b.listing_id)) {
      const l = await getListing(ctx.db, b.listing_id);
      if (l) listings.set(l.id, l);
    }
  }
  return messagePage(ctx, {
    title: 'My bookings',
    private: true,
    body: html`<h1>My bookings</h1><ul class="upcoming">${rows.map((b) => {
      const l = listings.get(b.listing_id);
      return html`<li><a class="title" href="/booking/${b.id}">${l?.title ?? 'Booking'}</a><span class="meta">${l?.first_starts_at ? fmtDate(l.first_starts_at) : ''} · ${b.status === 'confirmed' ? 'Confirmed' : b.status === 'pending' || b.status === 'hold' ? 'Payment pending' : 'Not active'}</span></li>`;
    })}</ul>`,
  });
}

export async function renderBooking(ctx: Ctx, id: string, notice?: SafeHtml): Promise<Response> {
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!grant) {
    // 404 rather than 403: never confirm whether a booking id exists.
    return messagePage(ctx, {
      title: 'Booking not found',
      status: 404,
      private: true,
      body: html`<h1>Booking not available on this device</h1><p>Open the private link from your confirmation email, or <a href="/booking/recover">ask for your link</a>.</p>`,
    });
  }
  const b = grant.booking;
  const listing = await getListing(ctx.db, b.listing_id);
  if (!listing) return messagePage(ctx, { title: 'Booking not found', status: 404, private: true, body: html`<h1>Booking not found</h1>` });
  const settings = await ctx.settings();
  const lessons = (await getAllLessons(ctx.db, listing.id)).filter((l) => l.status === 'scheduled');
  const confirmed = b.status === 'confirmed' && listing.status !== 'cancelled';
  const token = await bookingFormToken(ctx.cfg, b.id);
  const welcome = ctx.url.searchParams.get('welcome') === '1';
  const body = html`
    <p class="muted mb0">Booking ${b.id}</p>
    <h1>${listing.title}</h1>
    ${notice ? html`<div class="notice" role="status">${notice}</div>` : ''}
    ${statusBlock(b, listing, welcome)}
    <section class="summary-box" aria-labelledby="dates-title">
      <h2 id="dates-title">Your ${lessons.length > 1 ? `${lessons.length} dates` : 'date'} (UK time)</h2>
      ${dateList(lessons, { showMeeting: confirmed, cancelled: listing.status === 'cancelled' })}
      <ul class="facts">
        <li><span class="k">Name</span><span>${b.first_name}</span></li>
        <li><span class="k">Price</span><span>${fmtMoney(b.price_pence, b.currency)} total${lessons.length > 1 ? ` for all ${lessons.length} sessions` : ''}</span></li>
        <li><span class="k">Terms</span><span>Version ${b.terms_version}${b.early_start_requested ? ' · early start requested' : ''}</span></li>
      </ul>
      ${confirmed ? html`<div class="actions"><a class="btn btn-primary" href="/booking/${b.id}/calendar.ics" download>Add to calendar (.ics)</a></div>` : ''}
    </section>
    ${confirmed
      ? html`<section class="summary-box" aria-labelledby="link-title">
          <h2 id="link-title">Open this booking on another device</h2>
          <p class="small">Get a private link you can open on your phone or laptop. Anyone with the link can see this booking, so keep it to yourself.</p>
          <form method="post" action="/booking/${b.id}/new-link"><input type="hidden" name="t" value="${token}"><button class="btn btn-secondary" type="submit">Create a private link</button></form>
        </section>
        <section class="summary-box" aria-labelledby="cancel-title">
          <h2 id="cancel-title">Need to cancel?</h2>
          ${b.cancel_requested_at
            ? html`<p>You asked to cancel on ${fmtDate(b.cancel_requested_at)}. ${settings.seller_name || 'Bartek'} will reply by email.</p>`
            : html`<div class="policy small">${paragraphs(settings.cancellation_summary)}</div>
              <form method="post" action="/booking/${b.id}/cancel-request">
                <input type="hidden" name="t" value="${token}">
                <div class="field"><label for="note">Anything to add? <span class="hint">Optional</span></label><textarea id="note" name="note" maxlength="1000"></textarea></div>
                <button class="btn btn-secondary" type="submit">Request cancellation</button>
              </form>`}
        </section>`
      : ''}
    <form method="post" action="/booking/forget"><input type="hidden" name="b" value="${b.id}"><input type="hidden" name="t" value="${token}"><button class="btn btn-quiet" type="submit">Remove this booking from this device</button></form>
    <p class="small">Questions? ${settings.seller_email ? html`Email <a href="mailto:${settings.seller_email}">${settings.seller_email}</a>.` : ''}</p>`;
  return messagePage(ctx, { title: 'Your booking', private: true, body });
}

async function authorisedPost(ctx: Ctx, id: string): Promise<{ booking: BookingRow; form: URLSearchParams } | Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return messagePage(ctx, { title: 'Not allowed', status: 403, private: true, body: html`<h1>Not allowed</h1>` });
  const form = await readForm(ctx.req);
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!form || !grant || !(await checkBookingFormToken(ctx.cfg, id, form.get('t')))) {
    return messagePage(ctx, { title: 'Not allowed', status: 403, private: true, body: html`<h1>That didn't work</h1><p><a href="/booking">My booking</a></p>` });
  }
  return { booking: grant.booking, form };
}

export async function handleCancelRequest(ctx: Ctx, id: string): Promise<Response> {
  const auth = await authorisedPost(ctx, id);
  if (auth instanceof Response) return auth;
  const note = cleanText(auth.form.get('note') ?? '', 1000);
  await ctx.db
    .prepare(
      `UPDATE bookings SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_request_note = ?, cancel_request_handled_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'confirmed'`,
    )
    .bind(ctx.now, note || null, ctx.now, id)
    .run();
  return renderBooking(ctx, id, html`Your cancellation request has been sent. You'll get a reply by email.`);
}

export async function handleNewLink(ctx: Ctx, id: string): Promise<Response> {
  const auth = await authorisedPost(ctx, id);
  if (auth instanceof Response) return auth;
  if (auth.booking.status !== 'confirmed') return redirect(`/booking/${id}`, { private: true });
  const token = await issueAccessToken(ctx.db, id, 'link', 'student', ctx.now);
  const link = `${ctx.cfg.publicOrigin}/b/${token}`;
  return messagePage(ctx, {
    title: 'Your private link',
    private: true,
    body: html`<h1>Your private booking link</h1>
      <p>Open this on your other device. It's shown only once; keep it private.</p>
      <div class="copy-row"><input id="private-link" type="text" readonly value="${link}" aria-label="Private booking link"><button class="btn btn-secondary" type="button" data-copy="private-link" hidden>Copy</button></div>
      <p><a href="/booking/${id}">Back to your booking</a></p>`,
  });
}

export async function handleForget(ctx: Ctx): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return messagePage(ctx, { title: 'Not allowed', status: 403, private: true, body: html`<h1>Not allowed</h1>` });
  const form = await readForm(ctx.req);
  const id = form?.get('b') ?? '';
  const grants = await ctx.access();
  const grant = grants.get(id);
  if (!grant || !(await checkBookingFormToken(ctx.cfg, id, form?.get('t') ?? null))) return redirect('/booking', { private: true });
  const remaining = readCookieTokens(ctx.cookies, ctx.cfg).filter((t) => t !== grant.token);
  ctx.setCookies.push(accessCookie(ctx.cfg, remaining));
  return messagePage(ctx, { title: 'Removed', private: true, body: html`<h1>Removed from this device</h1><p>Your booking is still valid. Use your private link to open it again.</p>` });
}

export async function handleIcs(ctx: Ctx, id: string): Promise<Response> {
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!grant) return new Response('Not found', { status: 404, headers: privateHeaders() });
  const b = grant.booking;
  const listing = await getListing(ctx.db, b.listing_id);
  if (!listing || !['confirmed', 'cancelled'].includes(b.status)) return new Response('Not found', { status: 404, headers: privateHeaders() });
  const all = await getAllLessons(ctx.db, listing.id);
  const ics = bookingIcs(ctx, listing, all, b);
  return new Response(ics, {
    headers: {
      ...privateHeaders(),
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${listing.slug}.ics"`,
    },
  });
}

export function bookingIcs(ctx: { cfg: Ctx['cfg']; now: number }, listing: ListingRow, lessons: LessonRow[], b: BookingRow): string {
  const scheduled = lessons.filter((l) => l.status === 'scheduled');
  const page = `${ctx.cfg.publicOrigin}/booking/${b.id}`;
  const cancelledAll = listing.status === 'cancelled' || b.status === 'cancelled';
  return buildIcs({
    calendarName: listing.title,
    now: ctx.now,
    events: lessons.map((l) => {
      const n = scheduled.findIndex((x) => x.id === l.id) + 1;
      const cancelled = cancelledAll || l.status === 'cancelled';
      return {
        uid: l.uid,
        sequence: l.revision,
        start: l.starts_at,
        end: l.ends_at,
        summary: scheduled.length > 1 && n > 0 ? `${listing.title} (session ${n} of ${scheduled.length})` : listing.title,
        description: [
          cancelled ? 'This session has been cancelled.' : `Join link: ${l.meeting_url ?? 'shown on your booking page'}`,
          `Your booking page always has the latest time and link: ${page}`,
          '(It opens on the device you booked with, or from your private link.)',
        ].join('\n'),
        url: page,
        location: cancelled ? undefined : l.meeting_url ?? 'Online',
        status: cancelled ? ('CANCELLED' as const) : ('CONFIRMED' as const),
      };
    }),
  });
}

export async function renderRecover(ctx: Ctx, opts: { error?: string; done?: boolean; status?: number } = {}): Promise<Response> {
  if (opts.done) {
    return messagePage(ctx, {
      title: 'Request sent',
      private: true,
      body: html`<h1>Request sent</h1><div class="state state-confirmed" role="status"><p>If there's a booking for that email, you'll receive your private link by email, usually within a day.</p></div>`,
    });
  }
  return messagePage(ctx, {
    title: 'Get my private link',
    status: opts.status,
    private: true,
    body: html`<h1>Get your private booking link</h1>
      <p>Enter the email you booked with. For privacy the link is sent by email; it is never shown here.</p>
      ${opts.error ? html`<div class="error-box" role="alert">${opts.error}</div>` : ''}
      <form method="post" action="/booking/recover" data-once>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
        ${turnstileWidget(ctx.cfg, 'recover')}
        <button class="btn btn-primary" type="submit">Send my link</button>
      </form>`,
    turnstile: true,
  });
}

export async function handleRecoverPost(ctx: Ctx): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return renderRecover(ctx, { error: 'Please use the form on this site.', status: 403 });
  const form = await readForm(ctx.req);
  if (!form) return renderRecover(ctx, { error: 'Please try again.', status: 400 });
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'recover', 5, 3600, ctx.now))) {
    return renderRecover(ctx, { error: 'Too many requests. Please try again later.', status: 429 });
  }
  const email = normaliseEmail(form.get('email') ?? '');
  if (!isValidEmail(email)) return renderRecover(ctx, { error: 'Enter a valid email address.', status: 422 });
  const captcha = await verifyTurnstile(ctx.cfg, form.get('cf-turnstile-response'), ctx.ip);
  if (!captcha.ok) return renderRecover(ctx, { error: 'Please complete the "I am human" check.', status: 422 });
  const recent = await ctx.db
    .prepare('SELECT id FROM link_requests WHERE email = ? AND created_at > ? AND handled_at IS NULL')
    .bind(email, ctx.now - 86_400)
    .first();
  if (!recent) {
    await ctx.db
      .prepare('INSERT INTO link_requests (id, email, created_at) VALUES (?, ?, ?)')
      .bind(randomId('lr'), email, ctx.now)
      .run();
  }
  // Same response whether or not a booking exists (no account enumeration).
  return renderRecover(ctx, { done: true });
}
