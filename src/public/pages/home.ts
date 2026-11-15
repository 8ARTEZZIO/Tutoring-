import { refCookieName, verifyRef } from '../../shared/access';
import { type InviteRow, getListingBySlug, upcomingPublicListings } from '../../shared/db';
import { fmtMoney } from '../../shared/format';
import { type SafeHtml, html, paragraphs, raw } from '../../shared/html';
import { htmlResponse, isBot } from '../../shared/http';
import { countMetric } from '../../shared/metrics';
import { fmtDateShort } from '../../shared/time';
import {
  type ListingView,
  availabilityBadge,
  bookingCard,
  emptyCard,
  primaryCta,
  publicLayout,
  slotParts,
  stickyCta,
} from '../../shared/ui/public';
import { type Ctx, isPublicListing, loadView, loadViews } from '../context';

const EXERCISE = raw(`<p class="question">Question: how many scores in <code>[69, 70, 95]</code> are at or above 70?</p>
<pre class="code-card" aria-label="Python example"><code>scores = [<span class="n">69</span>, <span class="n">70</span>, <span class="n">95</span>]
count = <span class="n">0</span>
<span class="k">for</span> score <span class="k">in</span> scores:
    <span class="k">if</span> score &gt;= <span class="n">70</span>:   <span class="c"># "at or above" means &gt;=</span>
        count += <span class="n">1</span>
<span class="k">print</span>(count)         <span class="c"># prints 2</span></code></pre>`);

export async function welcomeBanner(ctx: Ctx): Promise<SafeHtml | null> {
  const grants = await ctx.access();
  if (grants.size === 0) return null;
  const active = [...grants.values()].filter((g) => ['confirmed', 'pending', 'hold'].includes(g.booking.status));
  if (active.length === 0) return null;
  const href = active.length === 1 ? `/booking/${active[0]!.booking.id}` : '/booking';
  return html`<div class="welcome"><div class="wrap">Welcome back. <a href="${href}">View your booking</a></div></div>`;
}

export async function invitedListingId(ctx: Ctx): Promise<string | null> {
  const inviteId = await verifyRef(ctx.cfg, ctx.cookies[refCookieName(ctx.cfg)]);
  if (!inviteId) return null;
  const invite = await ctx.db
    .prepare('SELECT * FROM invites WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
    .bind(inviteId, ctx.now)
    .first<InviteRow>();
  return invite?.listing_id ?? null;
}

function upcomingList(views: ListingView[]): SafeHtml {
  if (views.length === 0) {
    return html`<div class="state state-empty"><p class="mb0">No upcoming dates are published right now. <a href="/waitlist">Get the next date</a> by email.</p></div>`;
  }
  return html`<ul class="upcoming">
    ${views.slice(0, 6).map((v) => {
      const first = v.lessons[0];
      const s = first ? slotParts(first) : null;
      const isPackage = v.lessons.length > 1;
      return html`<li>
        <a class="title" href="/session/${v.listing.slug}">${v.listing.title}</a>
        <span class="meta">${s ? html`${s.date} · ${s.time}` : 'Date to be confirmed'}</span>
        ${isPackage ? html`<span class="meta">Package of ${v.lessons.length} dates: ${v.lessons.map((l) => fmtDateShort(l.starts_at)).join(', ')}</span>` : ''}
        <span>${fmtMoney(v.listing.price_pence, v.listing.currency)} total · ${availabilityBadge(v.availability)}</span>
      </li>`;
    })}
  </ul>`;
}

export function faq(settingsText: { whatToBring: string; howToJoin: string; cancellation: string }): SafeHtml {
  return html`<section class="section" id="faq" aria-labelledby="faq-title">
    <div class="wrap narrow">
      <h2 id="faq-title">Questions</h2>
      <details><summary>Who is it for?</summary><div><p>Kingston students aged 18 or over who can read basic Python (variables, <code>if</code>, <code>for</code> loops) but get stuck turning a test question into working code.</p></div></details>
      <details><summary>What should I bring?</summary><div><p>${settingsText.whatToBring}</p></div></details>
      <details><summary>How do I join?</summary><div><p>Sessions are live and online. ${settingsText.howToJoin}</p></div></details>
      <details><summary>How do cancellations work?</summary><div><p>${settingsText.cancellation}</p><p><a href="/terms">Read the booking terms</a>.</p></div></details>
      <details><summary>What does a package include?</summary><div><p>One payment books one seat for you on every date in that package. The dates are fixed and shown in full, with the total price, before you pay.</p></div></details>
      <details><summary>Is this run by Kingston University?</summary><div><p>No. This is independent peer tutoring by a student. It is not run by, affiliated with or endorsed by Kingston University.</p></div></details>
    </div>
  </section>`;
}

export async function renderHome(ctx: Ctx, opts: { notice?: SafeHtml | string | null; status?: number; featuredSlug?: string | null; invitedOverride?: boolean } = {}): Promise<Response> {
  const settings = await ctx.settings();
  const views = await loadViews(ctx, await upcomingPublicListings(ctx.db, ctx.now));
  const slug = opts.featuredSlug ?? ctx.url.searchParams.get('g');
  let featured: ListingView | null = null;
  let note: SafeHtml | string | null = opts.notice ?? null;
  if (slug) {
    featured = views.find((v) => v.listing.slug === slug) ?? null;
    if (!featured) {
      const listing = await getListingBySlug(ctx.db, slug);
      if (isPublicListing(listing)) featured = await loadView(ctx, listing);
    }
  }
  const invitedId = await invitedListingId(ctx);
  const invited = opts.invitedOverride ?? Boolean(featured && invitedId && featured.listing.id === invitedId);
  if (featured && !featured.availability.bookable && !note) {
    const alt = views.find((v) => v.availability.bookable && v.listing.id !== featured!.listing.id);
    const stateText: Record<string, string> = {
      sold_out: 'This group is full.',
      held_full: 'This group is full right now: the last seats are held by people checking out.',
      cutoff: 'Bookings for this group have closed because it starts soon.',
      closed: 'Bookings for this group are closed.',
      cancelled: 'This group has been cancelled.',
      past: 'This group has already finished.',
      paused: 'Bookings are paused for a moment.',
    };
    note = html`${stateText[featured.availability.state] ?? ''} ${alt ? html`Another date is open: <a href="/?g=${alt.listing.slug}">${alt.listing.title}</a>.` : html`<a href="/waitlist?l=${featured.listing.slug}">Join the waitlist</a> or <a href="/calendar">see the calendar</a>.`}`;
  }
  if (!featured) featured = views.find((v) => v.availability.bookable) ?? views[0] ?? null;

  if (!slug && !isBot(ctx.req) && ctx.req.method === 'GET') {
    const ref = ctx.url.searchParams.get('ref');
    ctx.exec.waitUntil(countMetric(ctx.db, 'visit', ref ?? 'direct', ctx.now).catch(() => undefined));
  }
  const ref = ctx.url.searchParams.get('ref');
  const card = featured ? bookingCard(featured, { invited, note, ref }) : emptyCard();
  const cta = featured ? primaryCta(featured, ref) : { label: 'Get the next date', href: '/waitlist', kind: 'waitlist' as const };
  const stickyText = featured
    ? `${featured.listing.title} · ${fmtMoney(featured.listing.price_pence, featured.listing.currency)}`
    : 'New dates coming soon';
  const others = views.filter((v) => !featured || v.listing.id !== featured.listing.id);

  const body = html`
  <section class="hero on-dark" aria-labelledby="hero-title">
    <div class="wrap hero-grid">
      <div>
        <span class="eyebrow">Live online · small groups · beginners</span>
        <h1 id="hero-title">Get unstuck on Python test questions.</h1>
        <p class="lede">Live small-group practice for beginners. Turn a question into working code, solve a fresh problem on your own, and get one written correction from ${settings.tutor_first_name}.</p>
      </div>
      <div>${card}</div>
    </div>
  </section>

  <section class="section" aria-labelledby="taste-title">
    <div class="wrap two-col">
      <div>
        <h2 id="taste-title">What happens in a class</h2>
        <ol class="steps">
          <li><strong>Work through one example</strong>We turn a test-style question into working code together, step by step.</li>
          <li><strong>Solve a fresh question under a timer</strong>You try a similar problem on your own, the way it feels in a test.</li>
          <li><strong>Get one thing to fix</strong>You get one written correction to focus on next.</li>
        </ol>
      </div>
      <div class="card flat">${EXERCISE}</div>
    </div>
  </section>

  <section class="section alt" aria-labelledby="about-title">
    <div class="wrap narrow">
      <h2 id="about-title">About ${settings.tutor_first_name}</h2>
      ${paragraphs(settings.tutor_intro)}
      <p class="muted small">Independent peer tutoring, not run by or affiliated with Kingston University.</p>
    </div>
  </section>

  <section class="section" aria-labelledby="upcoming-title">
    <div class="wrap">
      <div class="section-head">
        <h2 id="upcoming-title">${featured ? 'Other upcoming classes' : 'Upcoming classes'}</h2>
        <a href="/calendar">Open the calendar</a>
      </div>
      ${upcomingList(others)}
    </div>
  </section>

  ${faq({ whatToBring: settings.what_to_bring, howToJoin: settings.how_to_join, cancellation: settings.cancellation_summary })}
  `;
  return htmlResponse(
    publicLayout({
      cfg: ctx.cfg,
      settings,
      title: 'Python test question practice · Kingston Tutoring',
      body,
      sticky: stickyCta(cta.label, cta.href, stickyText),
      bannerHtml: await welcomeBanner(ctx),
    }),
    { status: opts.status ?? 200, private: Boolean(slug) || (await ctx.access()).size > 0 },
  );
}
