import { getListingBySlug, upcomingPublicListings } from '../../shared/db';
import { fmtMoney } from '../../shared/format';
import { type SafeHtml, html, paragraphs } from '../../shared/html';
import { htmlResponse } from '../../shared/http';
import {
  type ListingView,
  availabilityBadge,
  dateList,
  primaryCta,
  priceLabel,
  publicLayout,
  stickyCta,
} from '../../shared/ui/public';
import { type Ctx, isPublicListing, loadView, loadViews } from '../context';
import { notFoundPage } from './misc';

export function stateBlock(view: ListingView): SafeHtml {
  const { availability: av, listing } = view;
  switch (av.state) {
    case 'sold_out':
      return html`<div class="state state-soldout" role="status"><h2>Sold out</h2><p>All ${listing.capacity} seats are booked. Join the waitlist and you'll be told if a seat opens.</p></div>`;
    case 'held_full':
      return html`<div class="state state-soldout" role="status"><h2>Full right now</h2><p>The last seats are held by people checking out. Unpaid seats are released within 40 minutes; join the waitlist to hear if one opens.</p></div>`;
    case 'cancelled':
      return html`<div class="state state-cancelled" role="status"><h2>This group has been cancelled</h2><p>${listing.cancel_reason ?? ''} Anyone who paid will be refunded. <a href="/calendar">See other dates</a>.</p></div>`;
    case 'cutoff':
      return html`<div class="state state-cancelled" role="status"><h2>Bookings have closed</h2><p>This group starts soon, so online booking has closed.</p></div>`;
    case 'closed':
      return html`<div class="state state-cancelled" role="status"><h2>Bookings closed</h2><p>This group is no longer taking bookings.</p></div>`;
    case 'past':
      return html`<div class="state state-cancelled" role="status"><h2>This group has finished</h2><p><a href="/calendar">See upcoming dates</a>.</p></div>`;
    case 'paused':
      return html`<div class="state state-pending" role="status"><h2>Bookings paused</h2><p>Online booking is paused for a moment. Please check back soon or join the waitlist.</p></div>`;
    default:
      return html``;
  }
}

export async function renderListing(ctx: Ctx, slug: string): Promise<Response> {
  const listing = await getListingBySlug(ctx.db, slug);
  if (!isPublicListing(listing)) return notFoundPage(ctx);
  const settings = await ctx.settings();
  const view = await loadView(ctx, listing);
  const ref = ctx.url.searchParams.get('ref');
  const cta = primaryCta(view, ref);
  const isPackage = view.lessons.length > 1;
  let alternatives: ListingView[] = [];
  if (!view.availability.bookable) {
    alternatives = (await loadViews(ctx, await upcomingPublicListings(ctx.db, ctx.now))).filter(
      (v) => v.availability.bookable && v.listing.id !== listing.id,
    );
  }
  const body = html`<div class="page"><div class="wrap narrow">
    <p class="muted mb0">${listing.topic}</p>
    <h1>${listing.title}</h1>
    ${stateBlock(view)}
    ${listing.summary ? paragraphs(listing.summary) : ''}
    <div class="summary-box">
      <h2>${isPackage ? `${view.lessons.length} fixed dates (UK time)` : 'Date (UK time)'}</h2>
      ${dateList(view.lessons, { cancelled: listing.status === 'cancelled' })}
      <ul class="facts">
        <li><span class="k">Format</span><span>${listing.format} · live small group</span></li>
        <li><span class="k">Group</span><span>Up to ${listing.capacity} students</span></li>
        <li><span class="k">Seats</span><span>${availabilityBadge(view.availability)}</span></li>
      </ul>
      <div class="price-row">${priceLabel(listing, view.lessons.length)}</div>
      ${isPackage ? html`<p class="small">One payment of ${fmtMoney(listing.price_pence, listing.currency)} books one seat for you on all ${view.lessons.length} dates.</p>` : ''}
      <a class="btn btn-primary btn-block" href="${cta.href}" data-main-cta>${cta.label}</a>
    </div>
    ${alternatives.length
      ? html`<h2>Other dates with seats</h2><ul>${alternatives.slice(0, 4).map((v) => html`<li><a href="/session/${v.listing.slug}">${v.listing.title}</a></li>`)}</ul>`
      : ''}
    <p class="small"><a href="/terms">Booking terms and cancellation</a> · <a href="/calendar">Calendar</a></p>
  </div></div>`;
  return htmlResponse(
    publicLayout({
      cfg: ctx.cfg,
      settings,
      title: `${listing.title} · Kingston Tutoring`,
      description: `${listing.title}: ${view.lessons.length} live online session(s), up to ${listing.capacity} students.`,
      body,
      sticky: stickyCta(cta.label, cta.href, `${listing.title} · ${fmtMoney(listing.price_pence, listing.currency)}`),
    }),
  );
}
