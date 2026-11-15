import { accessCookie, issueAccessToken, readCookieTokens, refCookieName, verifyRef } from '../../shared/access';
import {
  COOLING_OFF_SECONDS,
  type CheckoutOutcome,
  checkoutUrlAllowed,
  claimSeat,
  createOrReplay,
  ensureCheckout,
  reconcileBooking,
} from '../../shared/booking';
import { looksLikeToken, randomToken, sha256Hex } from '../../shared/crypto';
import {
  type BookingRow,
  type InviteRow,
  type ListingRow,
  activeBookingFor,
  getBooking,
  getListingBySlug,
  upcomingPublicListings,
} from '../../shared/db';
import { cleanCode, cleanName, fmtMoney, isValidEmail, normaliseEmail } from '../../shared/format';
import { type SafeHtml, html, paragraphs } from '../../shared/html';
import { htmlResponse, isSameOrigin, log, readForm, redirect } from '../../shared/http';
import { countMetric, rateLimit } from '../../shared/metrics';
import { verifyTurnstile } from '../../shared/turnstile';
import { type ListingView, availabilityBadge, dateList, priceLabel, publicLayout, turnstileWidget } from '../../shared/ui/public';
import { type Ctx, isPublicListing, loadView, loadViews } from '../context';
import { inviteCode } from './invite';
import { stateBlock } from './listing';
import { messagePage, notFoundPage, sellerBox } from './misc';

interface Values {
  first_name: string;
  email: string;
  terms: boolean;
  early_request: boolean;
  early_ack: boolean;
  ref: string;
}

type Errors = Partial<Record<keyof Values | 'form', string>>;

export function needsEarlyStart(view: ListingView, now: number): boolean {
  const first = view.lessons[0];
  return Boolean(first && first.starts_at - now < COOLING_OFF_SECONDS);
}

function fieldError(errors: Errors, key: keyof Errors): SafeHtml {
  return errors[key] ? html`<p class="field-error" id="err-${key}">${errors[key]}</p>` : html``;
}

export async function renderBookForm(
  ctx: Ctx,
  view: ListingView,
  opts: { values?: Partial<Values>; errors?: Errors; status?: number } = {},
): Promise<Response> {
  const settings = await ctx.settings();
  const { listing, lessons } = view;
  const values = opts.values ?? {};
  const errors = opts.errors ?? {};
  const early = needsEarlyStart(view, ctx.now);
  const isPackage = lessons.length > 1;
  const price = fmtMoney(listing.price_pence, listing.currency);
  const nonce = randomToken(32);
  const errorList = Object.values(errors).filter(Boolean);
  const ref = values.ref ?? cleanCode(ctx.url.searchParams.get('ref'));
  const invalid = (k: keyof Errors) => (errors[k] ? 'true' : 'false');

  const body = html`<div class="page"><div class="wrap narrow">
    <p class="mb0"><a href="/session/${listing.slug}">← Class details</a></p>
    <h1>Book your seat</h1>
    ${errorList.length
      ? html`<div class="error-box" role="alert" tabindex="-1" id="form-errors"><strong>Please check the form:</strong><ul>${errorList.map((e) => html`<li>${e}</li>`)}</ul></div>`
      : ''}
    <section class="summary-box" aria-labelledby="sum-title">
      <h2 id="sum-title">${listing.title}</h2>
      ${dateList(lessons)}
      <ul class="facts">
        <li><span class="k">Format</span><span>${listing.format} · live small group</span></li>
        <li><span class="k">Group</span><span>Up to ${listing.capacity} students</span></li>
        <li><span class="k">Seats</span><span>${availabilityBadge(view.availability)}</span></li>
      </ul>
      <div class="price-row">${priceLabel(listing, lessons.length)}</div>
      ${isPackage ? html`<p class="small mb0">One payment of ${price} books one seat for you on all ${lessons.length} dates above.</p>` : ''}
    </section>
    <form method="post" action="/session/${listing.slug}/book" data-once>
      <input type="hidden" name="nonce" value="${nonce}">
      <input type="hidden" name="ref" value="${ref}">
      <div class="field">
        <label for="first_name">First name</label>
        <input id="first_name" name="first_name" type="text" autocomplete="given-name" required maxlength="60" value="${values.first_name ?? ''}" aria-invalid="${invalid('first_name')}" ${errors.first_name ? html`aria-describedby="err-first_name"` : ''}>
        ${fieldError(errors, 'first_name')}
      </div>
      <div class="field">
        <label for="email">Email <span class="hint">Your confirmation and private booking link are sent here.</span></label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" value="${values.email ?? ''}" aria-invalid="${invalid('email')}" ${errors.email ? html`aria-describedby="err-email"` : ''}>
        ${fieldError(errors, 'email')}
      </div>
      <fieldset>
        <legend>Cancellation</legend>
        <div class="policy small">${paragraphs(settings.cancellation_summary)}</div>
        ${early
          ? html`<p class="small"><strong>${isPackage ? 'This package starts' : 'This class starts'} within 14 days</strong>, inside your cancellation period. To book it you need to ask for it to start early:</p>
            <label class="check"><input type="checkbox" name="early_request" value="1" required ${values.early_request ? 'checked' : ''} aria-invalid="${invalid('early_request')}"> <span>${settings.early_start_request_text}</span></label>
            ${fieldError(errors, 'early_request')}
            <label class="check"><input type="checkbox" name="early_ack" value="1" required ${values.early_ack ? 'checked' : ''} aria-invalid="${invalid('early_ack')}"> <span>${settings.early_start_ack_text}</span></label>
            ${fieldError(errors, 'early_ack')}
            <p class="small mb0">Prefer to keep the full 14 days? <a href="/calendar">Choose a later date</a>.</p>`
          : ''}
      </fieldset>
      <label class="check"><input type="checkbox" name="terms" value="1" required ${values.terms ? 'checked' : ''} aria-invalid="${invalid('terms')}"> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">booking terms</a> (version ${settings.terms_version}).</span></label>
      ${fieldError(errors, 'terms')}
      ${sellerBox(settings)}
      ${turnstileWidget(ctx.cfg, 'book')}
      ${fieldError(errors, 'form')}
      <button class="btn btn-primary btn-block" type="submit" data-busy-label="Opening secure checkout…">Continue to payment · ${price}</button>
      <p class="cta-note">You'll pay on Stripe's secure page. Your seat is held for 40 minutes while you pay.</p>
    </form>
  </div></div>`;
  return htmlResponse(
    publicLayout({ cfg: ctx.cfg, settings, title: `Book: ${listing.title} · Kingston Tutoring`, body, turnstile: true, noindex: true }),
    { status: opts.status ?? 200, private: true },
  );
}

export async function handleBookGet(ctx: Ctx, slug: string): Promise<Response> {
  const listing = await getListingBySlug(ctx.db, slug);
  if (!isPublicListing(listing)) return notFoundPage(ctx);
  const view = await loadView(ctx, listing);
  if (!view.availability.bookable) return renderUnavailable(ctx, view, null);
  return renderBookForm(ctx, view);
}

export async function renderUnavailable(ctx: Ctx, view: ListingView, reason: string | null, status = 409): Promise<Response> {
  const alternatives = (await loadViews(ctx, await upcomingPublicListings(ctx.db, ctx.now))).filter(
    (v) => v.availability.bookable && v.listing.id !== view.listing.id,
  );
  const soldOut = reason === 'sold_out' || view.availability.state === 'sold_out' || view.availability.state === 'held_full';
  const body = html`
    <h1>${view.listing.title}</h1>
    ${soldOut
      ? html`<div class="state state-soldout" role="alert"><h2>Sorry, the last seat has just gone</h2><p>Someone else completed their booking first, so nothing has been charged. ${view.availability.held > 0 ? 'Some seats are held by people checking out and may be released within 40 minutes.' : ''}</p></div>`
      : stateBlock(view)}
    <div class="actions">
      <a class="btn btn-primary" href="/waitlist?l=${view.listing.slug}">Join the waitlist</a>
      <a class="btn btn-secondary" href="/calendar">See other dates</a>
    </div>
    ${alternatives.length
      ? html`<h2>Groups with seats</h2><ul>${alternatives.slice(0, 4).map((v) => html`<li><a href="/session/${v.listing.slug}">${v.listing.title}</a> · ${fmtMoney(v.listing.price_pence, v.listing.currency)}</li>`)}</ul>`
      : ''}`;
  return messagePage(ctx, { title: soldOut ? 'Sold out' : 'Not available', body, status, private: true });
}

async function inUsePage(ctx: Ctx): Promise<Response> {
  const s = await ctx.settings();
  return messagePage(ctx, {
    title: 'Booking already in progress',
    status: 409,
    private: true,
    body: html`<h1>This email already has a booking for this class</h1>
      <div class="state state-pending" role="alert"><p>There's already a booking or an unfinished checkout for this email on this class. Nothing new has been charged.</p></div>
      <ul>
        <li>If you've paid, open the private booking link from your confirmation email.</li>
        <li>If you started paying on another device, finish there. Unfinished checkouts are released within 40 minutes.</li>
        <li>Lost your link? <a href="/booking/recover">Ask for it again</a>${s.seller_email ? html` or email <a href="mailto:${s.seller_email}">${s.seller_email}</a>` : ''}.</li>
      </ul>`,
  });
}

function addTokenCookie(ctx: Ctx, token: string): void {
  const existing = readCookieTokens(ctx.cookies, ctx.cfg);
  ctx.setCookies.push(accessCookie(ctx.cfg, [token, ...existing]));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Release seats whose Checkout has passed its fixed expiry (verified with Stripe) before saying "sold out". */
async function reconcileExpiredHolds(ctx: Ctx, listingId: string): Promise<number> {
  const rows = await ctx.db
    .prepare(
      `SELECT * FROM bookings WHERE listing_id = ? AND status IN ('hold','pending')
         AND COALESCE(checkout_expires_at, created_at + 2400) < ? ORDER BY created_at LIMIT 3`,
    )
    .bind(listingId, ctx.now)
    .all<BookingRow>();
  let released = 0;
  for (const b of rows.results) {
    try {
      const outcome = await reconcileBooking(ctx.deps(), b, 'capacity-check');
      if (outcome.kind === 'released') released++;
    } catch (e) {
      log('warn', 'capacity_reconcile_failed', { booking: b.id, error: String(e).slice(0, 120) });
    }
  }
  return released;
}

export async function respondToOutcome(ctx: Ctx, outcome: CheckoutOutcome, listing: ListingRow): Promise<Response> {
  const b = outcome.booking;
  switch (outcome.kind) {
    case 'redirect':
      if (!checkoutUrlAllowed(ctx.cfg, outcome.url)) {
        log('error', 'checkout_url_rejected', { booking: b.id });
        return pendingPage(ctx, b, listing, 0);
      }
      return redirect(outcome.url, { private: true });
    case 'confirmed':
      return redirect(`/booking/${b.id}`, { private: true });
    case 'processing':
    case 'uncertain':
      return pendingPage(ctx, b, listing, 0);
    case 'exception':
      return messagePage(ctx, {
        title: 'Checking your payment',
        private: true,
        body: html`<h1>We're checking your payment</h1><div class="state state-pending" role="status"><p>Something about this payment needs a manual check, so your seat is being kept while Bartek looks at it. You don't need to pay again. Your booking reference is <strong>${b.id}</strong>.</p></div><p><a href="/booking/${b.id}">Open your booking page</a></p>`,
      });
    case 'released':
      if (outcome.reason === 'failed') {
        return messagePage(ctx, {
          title: 'Checkout could not start',
          status: 502,
          private: true,
          body: html`<h1>The payment page couldn't be opened</h1><div class="state state-soldout" role="alert"><p>Nothing has been charged and the seat has been released. Please try again.</p></div><div class="actions"><a class="btn btn-primary" href="/session/${listing.slug}/book">Try again</a><a class="btn btn-secondary" href="/session/${listing.slug}">Class details</a></div>`,
        });
      }
      return messagePage(ctx, {
        title: 'Checkout expired',
        private: true,
        body: html`<h1>That checkout has ended</h1><div class="state state-cancelled" role="status"><p>${outcome.reason === 'cancelled' ? 'This booking was cancelled before payment.' : 'The checkout expired before payment, so the seat was released. Nothing was charged.'}</p></div><div class="actions"><a class="btn btn-primary" href="/session/${listing.slug}">Book again</a></div>`,
      });
  }
}

export async function pendingPage(ctx: Ctx, booking: BookingRow, listing: ListingRow, attempt: number): Promise<Response> {
  const auto = attempt < 5;
  const next = `/checkout/resume?b=${booking.id}&n=${attempt + 1}`;
  return messagePage(ctx, {
    title: 'Preparing checkout',
    status: 202,
    private: true,
    headExtra: auto ? html`<meta http-equiv="refresh" content="4;url=${next}">` : undefined,
    body: html`<h1>Getting your secure checkout ready</h1>
      <div class="state state-pending" role="status">
        <p>Your seat on <strong>${listing.title}</strong> is held while we confirm the payment page with Stripe. Nothing has been charged yet.</p>
        ${auto ? html`<p class="mb0">This page will continue automatically.</p>` : html`<p class="mb0">Stripe is slow to respond. Your seat stays held; try again in a minute.</p>`}
      </div>
      <div class="actions"><a class="btn btn-primary" href="${next}">Continue to payment</a><a class="btn btn-secondary" href="/booking/${booking.id}">View booking status</a></div>`,
  });
}

export async function handleBookPost(ctx: Ctx, slug: string): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) {
    return messagePage(ctx, { title: 'Not allowed', status: 403, body: html`<h1>Please book from this site</h1><p><a href="/session/${slug}/book">Open the booking form</a></p>` });
  }
  const listing = await getListingBySlug(ctx.db, slug);
  if (!isPublicListing(listing)) return notFoundPage(ctx);
  const form = await readForm(ctx.req);
  if (!form) return messagePage(ctx, { title: 'Bad request', status: 400, body: html`<h1>Something was wrong with that form</h1><p><a href="/session/${slug}/book">Try again</a></p>` });
  if (!(await rateLimit(ctx.db, ctx.cfg.appSecret, ctx.ip, 'book', 12, 600, ctx.now))) {
    return messagePage(ctx, { title: 'Too many attempts', status: 429, private: true, body: html`<h1>Too many attempts</h1><p>Please wait a few minutes and try again.</p>` });
  }
  const settings = await ctx.settings();
  const view = await loadView(ctx, listing);
  const values: Values = {
    first_name: cleanName(form.get('first_name') ?? ''),
    email: normaliseEmail(form.get('email') ?? ''),
    terms: form.get('terms') === '1',
    early_request: form.get('early_request') === '1',
    early_ack: form.get('early_ack') === '1',
    ref: cleanCode(form.get('ref')),
  };
  const early = needsEarlyStart(view, ctx.now);
  const errors: Errors = {};
  if (!values.first_name) errors.first_name = 'Enter your first name.';
  if (!isValidEmail(values.email)) errors.email = 'Enter a valid email address, like name@example.com.';
  if (!values.terms) errors.terms = 'Tick the box to agree to the booking terms.';
  if (early && !values.early_request) errors.early_request = 'Tick the box to ask for the class to start within your cancellation period.';
  if (early && !values.early_ack) errors.early_ack = 'Tick the box to confirm you understand how cancellation works once the class starts.';
  const nonce = form.get('nonce') ?? '';
  if (!looksLikeToken(nonce)) errors.form = 'The form expired. Please submit it again.';
  if (Object.keys(errors).length) return renderBookForm(ctx, view, { values, errors, status: 422 });

  if (!ctx.cfg.stripe.ready) {
    log('error', 'stripe_not_configured', { problem: ctx.cfg.stripe.problem });
    return messagePage(ctx, { title: 'Booking unavailable', status: 503, body: html`<h1>Online booking is temporarily unavailable</h1><p>Nothing has been charged. Please try again later${settings.seller_email ? html` or email <a href="mailto:${settings.seller_email}">${settings.seller_email}</a>` : ''}.</p>` });
  }
  const captcha = await verifyTurnstile(ctx.cfg, form.get('cf-turnstile-response'), ctx.ip);
  if (!captcha.ok) {
    if (captcha.reason === 'unconfigured') log('error', 'turnstile_not_configured', {});
    return renderBookForm(ctx, view, { values, errors: { form: 'Please complete the "I am human" check and submit again.' }, status: 422 });
  }

  const nonceHash = await sha256Hex(nonce);
  const existing = await activeBookingFor(ctx.db, listing.id, values.email);
  if (existing) return handleExisting(ctx, existing, nonceHash, listing);
  if (!view.availability.bookable) return renderUnavailable(ctx, view, view.availability.state);

  const inviteId = await verifyRef(ctx.cfg, ctx.cookies[refCookieName(ctx.cfg)]);
  let invite: InviteRow | null = inviteId
    ? await ctx.db.prepare('SELECT * FROM invites WHERE id = ?').bind(inviteId).first<InviteRow>()
    : null;
  if (invite && (invite.revoked_at || (invite.expires_at && invite.expires_at <= ctx.now))) invite = null;
  const sourceCode = invite ? inviteCode(invite) : values.ref;
  const claimInput = {
    listingId: listing.id,
    email: values.email,
    firstName: values.first_name,
    source: invite ? ('invite' as const) : ('web' as const),
    sourceCode,
    inviteId: invite?.id ?? null,
    termsVersion: settings.terms_version,
    earlyStartRequested: early && values.early_request,
    earlyStartAck: early && values.early_ack,
    earlyStartTextVersion: early ? settings.early_start_version : null,
    nonceHash,
    status: 'hold' as const,
  };
  let claim = await claimSeat(ctx.deps(), claimInput);
  if (!claim.ok && claim.reason === 'sold_out' && (await reconcileExpiredHolds(ctx, listing.id)) > 0) {
    claim = await claimSeat(ctx.deps(), claimInput);
  }
  if (!claim.ok) {
    if (claim.reason === 'duplicate') {
      const again = await activeBookingFor(ctx.db, listing.id, values.email);
      if (again) return handleExisting(ctx, again, nonceHash, listing);
    }
    if (claim.reason === 'not_found') return notFoundPage(ctx);
    return renderUnavailable(ctx, await loadView(ctx, listing), claim.reason);
  }
  const booking = claim.booking;
  addTokenCookie(ctx, await issueAccessToken(ctx.db, booking.id, 'device', 'student', ctx.now));
  ctx.exec.waitUntil(countMetric(ctx.db, 'checkout_start', sourceCode, ctx.now).catch(() => undefined));
  const outcome = await createOrReplay(ctx.deps(), booking);
  return respondToOutcome(ctx, outcome, listing);
}

/**
 * The email already holds an active seat. Only the same browser (cookie) or the same form submission
 * (double-click: same nonce) may resume it; anyone else gets generic recovery instructions.
 */
async function handleExisting(ctx: Ctx, existing: BookingRow, nonceHash: string, listing: ListingRow): Promise<Response> {
  const grants = await ctx.access();
  const sameSubmission = existing.request_nonce_hash !== null && existing.request_nonce_hash === nonceHash;
  if (!grants.has(existing.id) && !sameSubmission) return inUsePage(ctx);
  if (!grants.has(existing.id)) addTokenCookie(ctx, await issueAccessToken(ctx.db, existing.id, 'device', 'student', ctx.now));
  let latest = existing;
  const started = Date.now();
  while (latest.status === 'hold' && ctx.now - latest.updated_at < 20 && Date.now() - started < 6000) {
    await sleep(300);
    latest = (await getBooking(ctx.db, existing.id)) ?? latest;
  }
  return respondToOutcome(ctx, await ensureCheckout(ctx.deps(), latest), listing);
}
