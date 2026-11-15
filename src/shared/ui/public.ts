import type { AppConfig } from '../config';
import type { Availability, LessonRow, ListingRow } from '../db';
import { fmtMoney } from '../format';
import { type SafeHtml, html, safeHref } from '../html';
import type { Settings } from '../settings';
import { fmtDate, fmtDateShort, fmtTimeRange, fmtTime, ukParts } from '../time';
import { PUBLIC_JS } from './script';
import { PUBLIC_CSS } from './styles';

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const CSS_VERSION = fnv1a(PUBLIC_CSS);
export const JS_VERSION = fnv1a(PUBLIC_JS);

export interface ListingView {
  listing: ListingRow;
  lessons: LessonRow[];
  availability: Availability;
}

export function availabilityBadge(av: Availability): SafeHtml {
  switch (av.state) {
    case 'open':
      return html`<span class="badge badge-ok">${av.left} of ${av.capacity} seats left</span>`;
    case 'few':
      return html`<span class="badge badge-warn">Only ${av.left} ${av.left === 1 ? 'seat' : 'seats'} left</span>`;
    case 'held_full':
      return html`<span class="badge badge-warn">Full right now · seats held in checkout</span>`;
    case 'sold_out':
      return html`<span class="badge badge-bad">Sold out</span>`;
    case 'closed':
      return html`<span class="badge badge-idle">Bookings closed</span>`;
    case 'cutoff':
      return html`<span class="badge badge-idle">Bookings closed · starting soon</span>`;
    case 'cancelled':
      return html`<span class="badge badge-bad">Cancelled</span>`;
    case 'past':
      return html`<span class="badge badge-idle">Finished</span>`;
    case 'draft':
      return html`<span class="badge badge-idle">Draft · not public</span>`;
    case 'paused':
      return html`<span class="badge badge-idle">Bookings paused</span>`;
  }
}

export interface Cta {
  label: string;
  href: string;
  kind: 'book' | 'waitlist' | 'browse';
}

export function primaryCta(view: ListingView, ref?: string | null): Cta {
  const { listing, availability } = view;
  const refQs = ref && ref !== 'direct' ? `?ref=${encodeURIComponent(ref)}` : '';
  if (availability.bookable) {
    return { label: `Book a seat · ${fmtMoney(listing.price_pence, listing.currency)}`, href: `/session/${listing.slug}/book${refQs}`, kind: 'book' };
  }
  if (['sold_out', 'held_full', 'cutoff', 'closed', 'paused'].includes(availability.state)) {
    return { label: 'Join the waitlist', href: `/waitlist?l=${encodeURIComponent(listing.slug)}`, kind: 'waitlist' };
  }
  return { label: 'See other dates', href: '/calendar', kind: 'browse' };
}

export function priceLabel(listing: ListingRow, lessonCount: number): SafeHtml {
  const total = fmtMoney(listing.price_pence, listing.currency);
  if (listing.kind === 'package' || lessonCount > 1) {
    return html`<span class="price">${total} <small>total for all ${lessonCount} sessions</small></span>`;
  }
  return html`<span class="price">${total} <small>total</small></span>`;
}

/** "Tue 24 Nov 2026 · 18:00–19:00 UK time (GMT)" style pieces used on cards and lists. */
export function slotParts(lesson: LessonRow): { date: string; time: string } {
  const range = fmtTimeRange(lesson.starts_at, lesson.ends_at);
  const zone = ukParts(lesson.starts_at).zone;
  const startZone = ukParts(lesson.starts_at).offsetMinutes;
  const endZone = ukParts(lesson.ends_at).offsetMinutes;
  const time = startZone === endZone ? `${range.replace(/ (GMT|BST)$/, '')} UK time (${zone})` : `${range} (UK time)`;
  return { date: fmtDate(lesson.starts_at), time };
}

export function dateList(
  lessons: LessonRow[],
  opts: { showMeeting?: boolean; cancelled?: boolean; idPrefix?: string } = {},
): SafeHtml {
  const total = lessons.length;
  return html`<ol class="date-list">
    ${lessons.map((l, i) => {
      const s = slotParts(l);
      return html`<li>
        <span class="when">${s.date}</span> · <span>${s.time}</span>
        ${total > 1 ? html`<br><span class="seq">Session ${i + 1} of ${total}</span>` : ''}
        ${opts.cancelled ? html` <span class="badge badge-bad">Cancelled</span>` : ''}
        ${opts.showMeeting && !opts.cancelled
          ? l.meeting_url
            ? html`<div class="meeting"><a class="btn btn-secondary" href="${safeHref(l.meeting_url)}" target="_blank" rel="noopener noreferrer">Open call link for session ${i + 1}</a></div>`
            : html`<div class="meeting muted small">Call link coming soon.</div>`
          : ''}
      </li>`;
    })}
  </ol>`;
}

export function bookingCard(
  view: ListingView,
  opts: { invited?: boolean; note?: SafeHtml | string | null; ref?: string | null; headingLevel?: 'h2' | 'h1' } = {},
): SafeHtml {
  const { listing, lessons, availability } = view;
  const first = lessons[0];
  const cta = primaryCta(view, opts.ref);
  const capacityLine = `Up to ${listing.capacity} students`;
  const firstSlot = first ? slotParts(first) : null;
  const isPackage = listing.kind === 'package' || lessons.length > 1;
  const stateClass =
    availability.state === 'sold_out' || availability.state === 'held_full'
      ? ' card-soldout'
      : availability.state === 'cancelled'
        ? ' card-cancelled'
        : '';
  return html`<section class="card booking-card${stateClass}" aria-labelledby="booking-card-title">
    <p class="topic">${listing.topic}</p>
    <h2 id="booking-card-title">${listing.title}</h2>
    ${opts.invited ? html`<p><span class="badge badge-lime">Your invitation</span></p>` : ''}
    ${opts.note ? html`<div class="notice small">${opts.note}</div>` : ''}
    <ul class="facts">
      ${firstSlot
        ? html`<li><span class="k">${isPackage ? 'Starts' : 'Date'}</span><span><strong>${firstSlot.date}</strong><br>${firstSlot.time}</span></li>`
        : html`<li><span class="k">Date</span><span>To be confirmed</span></li>`}
      ${isPackage
        ? html`<li><span class="k">Dates</span><span>${lessons.length} fixed sessions: ${lessons.map((l) => fmtDateShort(l.starts_at)).join(', ')} at ${first ? fmtTime(first.starts_at) : ''}</span></li>`
        : ''}
      <li><span class="k">Format</span><span>${listing.format} · live small group</span></li>
      <li><span class="k">Group</span><span>${capacityLine}</span></li>
      <li><span class="k">Seats</span><span>${availabilityBadge(availability)}</span></li>
    </ul>
    <div class="price-row">${priceLabel(listing, lessons.length)}</div>
    <a class="btn btn-primary btn-block" href="${cta.href}" data-main-cta>${cta.label}</a>
    <p class="cta-note">${
      cta.kind === 'book'
        ? isPackage
          ? 'One payment books one seat on every date. Secure checkout by Stripe.'
          : 'Pay securely with Stripe. Your seat is held while you check out.'
        : cta.kind === 'waitlist'
          ? availability.state === 'held_full'
            ? 'Seats held in checkout are released if not paid within 40 minutes.'
            : "We'll email you if a seat opens or a new date is added."
          : 'Pick another date from the calendar.'
    }</p>
  </section>`;
}

export function emptyCard(): SafeHtml {
  return html`<section class="card booking-card state-empty" aria-labelledby="booking-card-title">
    <p class="topic">Python test questions</p>
    <h2 id="booking-card-title">No dates published yet</h2>
    <p>New small-group sessions are added regularly. Leave your email and you'll hear about the next date first.</p>
    <a class="btn btn-primary btn-block" href="/waitlist" data-main-cta>Get the next date</a>
    <p class="cta-note">No spam: one email when a date is published.</p>
  </section>`;
}

export function stickyCta(label: string, href: string, text: string): SafeHtml {
  return html`<div class="sticky-cta on-dark" data-sticky-cta hidden>
    <span class="sc-text">${text}</span>
    <a class="btn btn-primary" href="${href}">${label}</a>
  </div>`;
}

export interface LayoutOptions {
  cfg: AppConfig;
  settings: Settings;
  title: string;
  description?: string;
  body: SafeHtml;
  turnstile?: boolean;
  noindex?: boolean;
  sticky?: SafeHtml | null;
  bannerHtml?: SafeHtml | null;
}

export function publicLayout(opts: LayoutOptions): SafeHtml {
  const s = opts.settings;
  const seller = s.seller_name.trim();
  const email = s.seller_email.trim();
  return html`<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<meta name="description" content="${opts.description ?? 'Live small-group Python practice for Kingston students. Turn test questions into working code.'}">
${opts.noindex ? html`<meta name="robots" content="noindex, nofollow">` : ''}
<meta name="theme-color" content="#0b1f3a">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css?v=${CSS_VERSION}">
${opts.turnstile && opts.cfg.turnstile.siteKey ? html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
<script src="/assets/app.js?v=${JS_VERSION}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site on-dark">
  <div class="wrap">
    <a class="brand" href="/">Kingston <span>Tutoring</span></a>
    <nav class="site-nav" aria-label="Main">
      <a href="/calendar">Calendar</a>
      <a href="/#faq">FAQ</a>
      <a href="/booking">My booking</a>
    </nav>
  </div>
</header>
${opts.bannerHtml ?? ''}
<main id="main">
${opts.body}
</main>
<footer class="site on-dark">
  <div class="wrap">
    <div>
      <p class="foot-label">Independent peer tutoring</p>
      <p class="small">Not run by, affiliated with or endorsed by Kingston University.</p>
      <p class="small">${seller ? html`Run by ${seller}${s.seller_address.trim() ? html`, ${s.seller_address.trim()}` : ''}.` : 'Seller details are being finalised.'}
      ${email ? html` Contact: <a href="mailto:${email}">${email}</a>` : ''}</p>
    </div>
    <ul class="foot-links">
      <li><a href="/terms">Booking terms</a></li>
      <li><a href="/privacy">Privacy</a></li>
      <li><a href="/calendar">Calendar</a></li>
      <li><a href="/booking/recover">Lost your booking link?</a></li>
    </ul>
  </div>
</footer>
${opts.sticky ?? ''}
</body>
</html>`;
}

export function turnstileWidget(cfg: AppConfig, action: string): SafeHtml {
  if (!cfg.turnstile.siteKey) return html``;
  return html`<div class="field"><div class="cf-turnstile" data-sitekey="${cfg.turnstile.siteKey}" data-action="${action}" data-theme="light"></div></div>`;
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b1f3a"/><path d="M18 22l12 10-12 10" fill="none" stroke="#c6f24e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 44h12" stroke="#c6f24e" stroke-width="6" stroke-linecap="round"/></svg>`;
