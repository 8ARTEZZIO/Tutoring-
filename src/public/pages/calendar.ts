import { type LessonRow, type ListingRow, upcomingPublicListings } from '../../shared/db';
import { fmtMoney } from '../../shared/format';
import { html } from '../../shared/html';
import { htmlResponse } from '../../shared/http';
import {
  addDaysToKey,
  fmtDayHeading,
  fmtTimeRange,
  fmtWeekLabel,
  mondayOfKey,
  parseDateKey,
  ukDateKey,
  ukMidnight,
} from '../../shared/time';
import { type ListingView, availabilityBadge, publicLayout } from '../../shared/ui/public';
import { type Ctx, loadViews } from '../context';

type AgendaRow = LessonRow & { listing_status: string };

export async function renderCalendar(ctx: Ctx): Promise<Response> {
  const settings = await ctx.settings();
  const todayKey = ukDateKey(ctx.now);
  const weekParam = ctx.url.searchParams.get('week') ?? '';
  const monday = parseDateKey(weekParam) ? mondayOfKey(weekParam) : mondayOfKey(todayKey);
  const start = ukMidnight(monday);
  const end = ukMidnight(addDaysToKey(monday, 7));

  const lessonsRes = await ctx.db
    .prepare(
      `SELECT le.*, li.status AS listing_status FROM lessons le JOIN listings li ON li.id = le.listing_id
       WHERE le.status = 'scheduled' AND li.status IN ('published','closed') AND le.starts_at >= ? AND le.starts_at < ?
       ORDER BY le.starts_at, le.id`,
    )
    .bind(start, end)
    .all<AgendaRow>();
  const listingIds = [...new Set(lessonsRes.results.map((l) => l.listing_id))];
  let weekListings: ListingRow[] = [];
  if (listingIds.length) {
    const res = await ctx.db
      .prepare(`SELECT * FROM listings WHERE id IN (${listingIds.map(() => '?').join(',')})`)
      .bind(...listingIds)
      .all<ListingRow>();
    weekListings = res.results;
  }
  const weekViews = new Map((await loadViews(ctx, weekListings)).map((v) => [v.listing.id, v]));

  // "Jump to next available session": first bookable listing's first date.
  const upcoming = await loadViews(ctx, await upcomingPublicListings(ctx.db, ctx.now));
  const nextBookable = upcoming
    .filter((v) => v.availability.bookable && v.lessons[0])
    .sort((a, b) => a.lessons[0]!.starts_at - b.lessons[0]!.starts_at)[0];
  const nextWeek = nextBookable ? mondayOfKey(ukDateKey(nextBookable.lessons[0]!.starts_at)) : null;

  const days = Array.from({ length: 7 }, (_, i) => addDaysToKey(monday, i));
  const byDay = new Map<string, AgendaRow[]>();
  for (const l of lessonsRes.results) {
    const key = ukDateKey(l.starts_at);
    byDay.set(key, [...(byDay.get(key) ?? []), l]);
  }

  const item = (l: AgendaRow, v: ListingView | undefined) => {
    if (!v) return html``;
    const isPackage = v.listing.lesson_count > 1;
    const number = v.lessons.findIndex((x) => x.id === l.id) + 1;
    return html`<div class="agenda-item${isPackage ? ' pkg' : ''}">
      <span class="time">${fmtTimeRange(l.starts_at, l.ends_at)} <span class="muted small">UK time</span></span>
      <a href="/session/${v.listing.slug}">${v.listing.title}</a>
      ${isPackage
        ? html`<span class="pkg-label">Package · session ${number || l.seq} of ${v.listing.lesson_count}. One booking covers all ${v.listing.lesson_count} dates.</span>`
        : ''}
      <span>${fmtMoney(v.listing.price_pence, v.listing.currency)} total · ${availabilityBadge(v.availability)}</span>
    </div>`;
  };

  const body = html`<div class="page"><div class="wrap narrow">
    <h1>Class calendar</h1>
    <p class="muted">All times are UK time. Week of ${fmtWeekLabel(monday)}.</p>
    <nav class="agenda-nav" aria-label="Weeks">
      <a class="btn btn-secondary" href="/calendar?week=${addDaysToKey(monday, -7)}" rel="nofollow">← Previous week</a>
      <a class="btn btn-secondary" href="/calendar?week=${addDaysToKey(monday, 7)}" rel="nofollow">Next week →</a>
      ${monday !== mondayOfKey(todayKey) ? html`<a class="btn btn-quiet" href="/calendar">This week</a>` : ''}
      ${nextWeek
        ? html`<a class="btn btn-primary" href="/calendar?week=${nextWeek}#d-${ukDateKey(nextBookable!.lessons[0]!.starts_at)}">Jump to next available session</a>`
        : html`<a class="btn btn-primary" href="/waitlist">Get the next date</a>`}
    </nav>
    ${days.map((key) => {
      const items = byDay.get(key) ?? [];
      return html`<section class="agenda-day${key === todayKey ? ' today' : ''}" id="d-${key}" aria-labelledby="h-${key}">
        <h2 id="h-${key}">${fmtDayHeading(key)}${key === todayKey ? ' · today' : ''}</h2>
        ${items.length ? items.map((l) => item(l, weekViews.get(l.listing_id))) : html`<p class="agenda-empty">No classes.</p>`}
      </section>`;
    })}
    ${!nextBookable ? html`<div class="state state-empty"><p class="mb0">No bookable dates right now. <a href="/waitlist">Leave your email</a> to hear about the next one.</p></div>` : ''}
  </div></div>`;
  return htmlResponse(publicLayout({ cfg: ctx.cfg, settings, title: 'Calendar · Kingston Tutoring', body }));
}
