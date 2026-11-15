import { checkBookingFormToken, bookingFormToken } from '../../shared/access';
import { ensureCheckout, expireAndRelease, reconcileBooking } from '../../shared/booking';
import { type BookingRow, getBooking, getListing } from '../../shared/db';
import { html } from '../../shared/html';
import { isSameOrigin, readForm, redirect } from '../../shared/http';
import { fmtTime } from '../../shared/time';
import type { Ctx } from '../context';
import { pendingPage, respondToOutcome } from './book';
import { messagePage } from './misc';

const BOOKING_ID = /^bk_[a-z0-9]{16}$/;

async function neutralReturnPage(ctx: Ctx): Promise<Response> {
  return messagePage(ctx, {
    title: 'Thanks',
    private: true,
    body: html`<h1>Thanks for booking</h1>
      <div class="state state-pending" role="status"><p>If your payment went through, your seat is confirmed. For privacy, booking details only open on the device you booked with, or from the private link in your confirmation email.</p></div>
      <div class="actions"><a class="btn btn-primary" href="/booking">My booking</a><a class="btn btn-secondary" href="/booking/recover">Get my private link</a></div>`,
  });
}

/**
 * Stripe success_url. The query string is never trusted: payment is verified server-side with Stripe
 * using the session id stored on the booking, and details are shown only to an authorised device.
 */
export async function handleReturn(ctx: Ctx): Promise<Response> {
  const id = ctx.url.searchParams.get('b') ?? '';
  const sessionParam = ctx.url.searchParams.get('session_id');
  if (!BOOKING_ID.test(id)) return neutralReturnPage(ctx);
  const booking = await getBooking(ctx.db, id);
  if (!booking) return neutralReturnPage(ctx);
  const grants = await ctx.access();
  if (!grants.has(id)) {
    // Same-browser cookie missing (e.g. checkout finished in another browser). Reconcile only if the
    // session id matches what we stored, and still reveal nothing.
    if ((booking.status === 'pending' || booking.status === 'hold') && sessionParam && sessionParam === booking.checkout_session_id) {
      await reconcileBooking(ctx.deps(), booking, 'return-unauthenticated');
    }
    return neutralReturnPage(ctx);
  }
  return confirmOrWait(ctx, booking, Number(ctx.url.searchParams.get('n') ?? '0') || 0);
}

async function confirmOrWait(ctx: Ctx, bookingIn: BookingRow, attempt: number): Promise<Response> {
  let booking = bookingIn;
  if (booking.status === 'hold' || booking.status === 'pending') {
    const outcome = await reconcileBooking(ctx.deps(), booking, 'return');
    booking = outcome.booking;
  }
  if (booking.status === 'confirmed') return redirect(`/booking/${booking.id}?welcome=1`, { private: true });
  if (booking.status === 'pending' || booking.status === 'hold') {
    const auto = attempt < 10;
    const listing = await getListing(ctx.db, booking.listing_id);
    return messagePage(ctx, {
      title: 'Confirming payment',
      status: 202,
      private: true,
      headExtra: auto ? html`<meta http-equiv="refresh" content="3;url=/checkout/return?b=${booking.id}&n=${attempt + 1}">` : undefined,
      body: html`<h1>Confirming your payment</h1>
        <div class="state state-pending" role="status">
          <p><strong>Payment pending.</strong> Your seat on ${listing?.title ?? 'this class'} is held while Stripe confirms the payment. This usually takes a few seconds.</p>
          <p class="mb0">${auto ? 'This page updates automatically.' : 'Still waiting. You can close this page: your booking page will show the confirmed status as soon as Stripe verifies the payment.'}</p>
        </div>
        <div class="actions"><a class="btn btn-secondary" href="/booking/${booking.id}">View booking status</a></div>`,
    });
  }
  return redirect(`/booking/${booking.id}`, { private: true });
}

export async function handleCancelled(ctx: Ctx): Promise<Response> {
  const id = ctx.url.searchParams.get('b') ?? '';
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!grant) {
    return messagePage(ctx, {
      title: 'Checkout not completed',
      private: true,
      body: html`<h1>Checkout not completed</h1><p>Nothing has been charged.</p><div class="actions"><a class="btn btn-primary" href="/">See classes</a></div>`,
    });
  }
  const booking = grant.booking;
  const listing = await getListing(ctx.db, booking.listing_id);
  if (booking.status !== 'pending' && booking.status !== 'hold') return redirect(`/booking/${booking.id}`, { private: true });
  const token = await bookingFormToken(ctx.cfg, booking.id);
  return messagePage(ctx, {
    title: 'Checkout not completed',
    private: true,
    body: html`<h1>You haven't paid yet</h1>
      <div class="state state-pending" role="status"><p>Your seat on <strong>${listing?.title ?? 'this class'}</strong> is held until about ${booking.checkout_expires_at ? fmtTime(booking.checkout_expires_at) : 'the checkout expires'} (UK time). Nothing has been charged.</p></div>
      <div class="actions">
        <a class="btn btn-primary" href="/checkout/resume?b=${booking.id}">Return to secure checkout</a>
        <form method="post" action="/checkout/release">
          <input type="hidden" name="b" value="${booking.id}"><input type="hidden" name="t" value="${token}">
          <button class="btn btn-secondary" type="submit">Release my seat</button>
        </form>
      </div>`,
  });
}

export async function handleResume(ctx: Ctx): Promise<Response> {
  const id = ctx.url.searchParams.get('b') ?? '';
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!grant) return redirect('/booking', { private: true });
  const listing = await getListing(ctx.db, grant.booking.listing_id);
  if (!listing) return redirect('/booking', { private: true });
  const attempt = Number(ctx.url.searchParams.get('n') ?? '0') || 0;
  const outcome = await ensureCheckout(ctx.deps(), grant.booking);
  if (outcome.kind === 'uncertain' || outcome.kind === 'processing') return pendingPage(ctx, outcome.booking, listing, attempt);
  return respondToOutcome(ctx, outcome, listing);
}

export async function handleRelease(ctx: Ctx): Promise<Response> {
  if (!isSameOrigin(ctx.req, ctx.cfg.publicOrigin)) return messagePage(ctx, { title: 'Not allowed', status: 403, body: html`<h1>Not allowed</h1>` });
  const form = await readForm(ctx.req);
  const id = form?.get('b') ?? '';
  const grants = await ctx.access();
  const grant = BOOKING_ID.test(id) ? grants.get(id) : undefined;
  if (!grant || !(await checkBookingFormToken(ctx.cfg, id, form?.get('t') ?? null))) {
    return messagePage(ctx, { title: 'Not allowed', status: 403, private: true, body: html`<h1>That link has expired</h1><p><a href="/booking">My booking</a></p>` });
  }
  const outcome = await expireAndRelease(ctx.deps(), grant.booking, 'expired');
  if (outcome.kind === 'released') {
    return messagePage(ctx, { title: 'Seat released', private: true, body: html`<h1>Seat released</h1><p>Your checkout was closed and nothing was charged.</p><div class="actions"><a class="btn btn-primary" href="/">See classes</a></div>` });
  }
  if (outcome.kind === 'confirmed') return redirect(`/booking/${id}`, { private: true });
  return messagePage(ctx, {
    title: 'Still checking',
    private: true,
    body: html`<h1>We couldn't close the checkout yet</h1><p>Stripe didn't confirm in time. If you don't pay, the seat is released automatically when the checkout expires.</p><p><a href="/booking/${id}">View booking</a></p>`,
  });
}
