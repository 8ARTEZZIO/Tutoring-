import { cancelListing, settleCancelledListing } from '../../shared/booking';
import { randomId } from '../../shared/crypto';
import {
  type BookingRow,
  type LessonRow,
  type ListingRow,
  OCCUPYING_SQL,
  auditStatement,
  availabilityOf,
  getAllLessons,
  getLessons,
  getListing,
  refreshScheduleStatements,
  seatCounts,
} from '../../shared/db';
import { cleanText, isHttpsUrl, isPlaceholderUrl, slugify } from '../../shared/format';
import { type SafeHtml, html } from '../../shared/html';
import { redirect } from '../../shared/http';
import { sellerReady } from '../../shared/settings';
import { fmtSlotUk, fmtTimeRange, fmtDate, toDateInput, toTimeInput, ukLocalToUtc } from '../../shared/time';
import { bookingCard, dateList, publicLayout } from '../../shared/ui/public';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, csrfField, listingBadge, postButton, table } from '../ui';
import { invitesSection } from './invites';
import { messagesSection } from './messages';
import { manualBookingForm, rosterSection } from './roster';
import { listingWaitlistSection } from './waitlist';

export function parsePounds(value: string): number | null {
  const v = value.replace(/[£,\s]/g, '');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(v)) return null;
  return Math.round(Number(v) * 100);
}

function poundsInput(pence: number): string {
  return (pence / 100).toFixed(2);
}

interface ListingInput {
  title: string;
  topic: string;
  slug: string;
  kind: 'single' | 'package';
  summary: string;
  price_pence: number;
  capacity: number;
  cutoff_minutes: number;
  format: string;
}

function readListingForm(ctx: AdminCtx): { input: ListingInput; errors: string[] } {
  const errors: string[] = [];
  const title = cleanText(field(ctx, 'title'), 120);
  const topic = cleanText(field(ctx, 'topic'), 80);
  const slug = slugify(field(ctx, 'slug') || title);
  const kind = field(ctx, 'kind') === 'package' ? 'package' : 'single';
  const summary = cleanText(field(ctx, 'summary'), 2000);
  const price = parsePounds(field(ctx, 'price'));
  const capacity = Number(field(ctx, 'capacity'));
  const cutoff = Number(field(ctx, 'cutoff_minutes') || '120');
  const format = cleanText(field(ctx, 'format') || 'Online', 40);
  if (!title) errors.push('Title is required.');
  if (!topic) errors.push('Topic is required.');
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(slug)) errors.push('Slug must be 3-60 lowercase letters, numbers or dashes.');
  if (price === null || price < 30) errors.push('Price must be at least £0.30 (Stripe minimum), e.g. 15 or 80.00.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) errors.push('Capacity must be between 1 and 50.');
  if (!Number.isInteger(cutoff) || cutoff < 45 || cutoff > 20160) {
    errors.push('Booking cutoff must be at least 45 minutes so Checkout (40 minutes) can finish before class.');
  }
  return {
    input: { title, topic, slug, kind, summary, price_pence: price ?? 0, capacity, cutoff_minutes: cutoff, format },
    errors,
  };
}

export async function activeBookingCount(db: D1Database, listingId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE listing_id = ? AND status IN ${OCCUPYING_SQL}`)
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- Clashes ----------------------------------------------------------------------------------------

export interface Clash {
  lessonId: string | null;
  otherListingId: string;
  otherTitle: string;
  otherStatus: string;
  starts_at: number;
  ends_at: number;
  bookable: boolean;
}

export async function findClashes(
  db: D1Database,
  listing: ListingRow,
  slots: { id: string | null; starts_at: number; ends_at: number }[],
): Promise<Clash[]> {
  const clashes: Clash[] = [];
  for (const slot of slots) {
    const res = await db
      .prepare(
        `SELECT le.id, le.listing_id, le.starts_at, le.ends_at, li.title, li.status FROM lessons le
         JOIN listings li ON li.id = le.listing_id
         WHERE le.status = 'scheduled' AND li.tutor = ? AND li.status IN ('draft','published','closed')
           AND le.starts_at < ? AND ? < le.ends_at AND le.id != COALESCE(?, '')`,
      )
      .bind(listing.tutor, slot.ends_at, slot.starts_at, slot.id)
      .all<{ id: string; listing_id: string; starts_at: number; ends_at: number; title: string; status: string }>();
    for (const r of res.results) {
      clashes.push({
        lessonId: slot.id,
        otherListingId: r.listing_id,
        otherTitle: r.listing_id === listing.id ? `${r.title} (same listing)` : r.title,
        otherStatus: r.status,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        bookable: r.listing_id === listing.id || r.status === 'published' || r.status === 'closed',
      });
    }
  }
  return clashes;
}

// ---- Publish checks -----------------------------------------------------------------------------------

export async function publishProblems(ctx: AdminCtx, listing: ListingRow, lessons: LessonRow[]): Promise<{ blocking: string[]; warnings: string[] }> {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const settings = await ctx.settings();
  if (lessons.length === 0) blocking.push('Add at least one date.');
  if (listing.kind === 'package' && lessons.length < 2) blocking.push('A package needs at least two dates.');
  if (listing.price_pence < 30) blocking.push('Set a price.');
  for (const [i, l] of lessons.entries()) {
    if (!l.meeting_url) blocking.push(`Date ${i + 1} (${fmtDate(l.starts_at)}) has no call link.`);
    else if (!isHttpsUrl(l.meeting_url)) blocking.push(`Date ${i + 1} call link must start with https://.`);
    else if (isPlaceholderUrl(l.meeting_url)) {
      (ctx.cfg.isProduction ? blocking : warnings).push(`Date ${i + 1} uses a placeholder call link (${new URL(l.meeting_url).hostname}).`);
    }
  }
  const first = lessons[0];
  if (first && first.starts_at - listing.cutoff_minutes * 60 <= ctx.now + 300) {
    blocking.push('The first date is too soon: bookings would already be closed by the cutoff.');
  }
  if (!sellerReady(settings)) {
    (ctx.cfg.isProduction ? blocking : warnings).push('Seller name, address and contact email are not set (Settings). They must be shown before payment.');
  }
  const clashes = await findClashes(ctx.db, listing, lessons.map((l) => ({ id: l.id, starts_at: l.starts_at, ends_at: l.ends_at })));
  for (const c of clashes) {
    const text = `Clash: ${fmtSlotUk(c.starts_at, c.ends_at)} overlaps "${c.otherTitle}" (${c.otherStatus}).`;
    if (c.bookable) blocking.push(text);
    else warnings.push(text);
  }
  return { blocking: [...new Set(blocking)], warnings: [...new Set(warnings)] };
}

// ---- Pages --------------------------------------------------------------------------------------------

function listingForm(ctx: AdminCtx, listing: ListingRow | null, values?: Partial<ListingInput>): SafeHtml {
  const v = { ...(listing ?? {}), ...(values ?? {}) } as Partial<ListingInput & ListingRow>;
  const action = listing ? `/listings/${listing.id}/update` : '/listings';
  return html`<form method="post" action="${action}">${csrfField(ctx)}
    <div class="row c2">
      <div class="f"><label for="title">Title</label><input id="title" name="title" type="text" required maxlength="120" value="${v.title ?? ''}"></div>
      <div class="f"><label for="topic">Topic <span class="hint">shown above the title</span></label><input id="topic" name="topic" type="text" required maxlength="80" value="${v.topic ?? 'Python test questions'}"></div>
    </div>
    <div class="row c3">
      <div class="f"><label for="slug">Link name <span class="hint">/session/…</span></label><input id="slug" name="slug" type="text" maxlength="60" value="${v.slug ?? ''}" placeholder="from the title"></div>
      <div class="f"><label for="kind">Type</label><select id="kind" name="kind"><option value="single" ${v.kind !== 'package' ? 'selected' : ''}>Single class</option><option value="package" ${v.kind === 'package' ? 'selected' : ''}>Package (fixed dates, one payment)</option></select></div>
      <div class="f"><label for="format">Format</label><input id="format" name="format" type="text" maxlength="40" value="${v.format ?? 'Online'}"></div>
    </div>
    <div class="row c3">
      <div class="f"><label for="price">Total price (£) <span class="hint">per student, all dates</span></label><input id="price" name="price" type="text" inputmode="decimal" required value="${v.price_pence !== undefined ? poundsInput(v.price_pence) : ''}"></div>
      <div class="f"><label for="capacity">Seats</label><input id="capacity" name="capacity" type="number" min="1" max="50" required value="${v.capacity ?? 8}"></div>
      <div class="f"><label for="cutoff_minutes">Booking cutoff <span class="hint">minutes before the first date (min 45)</span></label><input id="cutoff_minutes" name="cutoff_minutes" type="number" min="45" required value="${v.cutoff_minutes ?? 120}"></div>
    </div>
    <div class="f"><label for="summary">Description <span class="hint">optional, shown on the class page</span></label><textarea id="summary" name="summary" maxlength="2000">${v.summary ?? ''}</textarea></div>
    ${listing && listing.status !== 'draft' ? html`<p class="small muted">Price changes apply to new bookings only; existing bookings keep the price they paid.</p>` : ''}
    <button class="primary" type="submit">${listing ? 'Save details' : 'Create draft'}</button>
  </form>`;
}

export async function renderNewListing(ctx: AdminCtx, opts: { errors?: string[]; values?: Partial<ListingInput> } = {}): Promise<Response> {
  return adminLayout(ctx, {
    title: 'New listing',
    status: opts.errors?.length ? 422 : 200,
    body: html`<h1>New listing</h1>
      ${opts.errors?.length ? html`<div class="flash err"><ul>${opts.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
      <div class="card">${listingForm(ctx, null, opts.values)}</div>
      <p class="muted small">Listings start as drafts. Add dates and call links, then publish.</p>`,
  });
}

export async function handleCreateListing(ctx: AdminCtx): Promise<Response> {
  const { input, errors } = readListingForm(ctx);
  if (errors.length) return renderNewListing(ctx, { errors, values: input });
  const existing = await ctx.db.prepare('SELECT id FROM listings WHERE slug = ?').bind(input.slug).first();
  if (existing) return renderNewListing(ctx, { errors: ['That link name is already used.'], values: input });
  const id = randomId('lst', 12);
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO listings (id, slug, kind, title, topic, summary, price_pence, capacity, cutoff_minutes, format, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(id, input.slug, input.kind, input.title, input.topic, input.summary, input.price_pence, input.capacity, input.cutoff_minutes, input.format, ctx.now, ctx.now),
    auditStatement(ctx.db, ctx.email, 'listing_created', 'listing', id, { title: input.title }, ctx.now),
  ]);
  return back(`/listings/${id}`, { ok: 'Draft created. Add the dates next.' });
}

export async function handleUpdateListing(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const { input, errors } = readListingForm(ctx);
  if (errors.length) return back(`/listings/${listing.id}`, { err: errors.join(' ') });
  if (input.slug !== listing.slug) {
    const clash = await ctx.db.prepare('SELECT id FROM listings WHERE slug = ? AND id != ?').bind(input.slug, listing.id).first();
    if (clash) return back(`/listings/${listing.id}`, { err: 'That link name is already used.' });
  }
  const active = await activeBookingCount(ctx.db, listing.id);
  if (input.capacity < active) return back(`/listings/${listing.id}`, { err: `Capacity cannot go below the ${active} seats already taken.` });
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE listings SET slug = ?, kind = ?, title = ?, topic = ?, summary = ?, price_pence = ?, capacity = ?, cutoff_minutes = ?, format = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.slug, input.kind, input.title, input.topic, input.summary, input.price_pence, input.capacity, input.cutoff_minutes, input.format, ctx.now, listing.id),
    ...refreshScheduleStatements(ctx.db, listing.id, ctx.now),
    auditStatement(ctx.db, ctx.email, 'listing_updated', 'listing', listing.id, { ...input, summary: undefined }, ctx.now),
  ]);
  return back(`/listings/${listing.id}`, { ok: 'Saved.' });
}

function lessonFormFields(prefix: { date?: string; time?: string; duration?: number; url?: string }, ambiguous?: { ts: number; offsetMinutes: number; zone: string }[]): SafeHtml {
  return html`<div class="row c4">
    <div class="f"><label for="date">Date (UK)</label><input id="date" name="date" type="date" required value="${prefix.date ?? ''}"></div>
    <div class="f"><label for="time">Start (UK time)</label><input id="time" name="time" type="time" required value="${prefix.time ?? '18:00'}"></div>
    <div class="f"><label for="duration">Length (minutes)</label><input id="duration" name="duration" type="number" min="15" max="480" required value="${prefix.duration ?? 60}"></div>
    <div class="f"><label for="meeting_url">Private call link <span class="hint">https://, shown only to confirmed students</span></label><input id="meeting_url" name="meeting_url" type="url" value="${prefix.url ?? ''}" placeholder="https://meet.google.com/…"></div>
  </div>
  ${ambiguous
    ? html`<fieldset class="warnbox"><legend>This time happens twice (clocks go back). Which one?</legend>
        ${ambiguous.map((o) => html`<label><input type="radio" name="offset" value="${o.offsetMinutes}" required> ${o.zone === 'BST' ? 'First' : 'Second'} occurrence (${o.zone}, ${new Date(o.ts * 1000).toISOString().slice(11, 16)} UTC)</label>`)}
      </fieldset>`
    : ''}`;
}

export async function renderListingPage(ctx: AdminCtx, listing: ListingRow, extra: { lessonError?: string; lessonValues?: Record<string, string>; ambiguous?: { ts: number; offsetMinutes: number; zone: string }[] } = {}): Promise<Response> {
  const [lessons, allLessons, counts] = await Promise.all([
    getLessons(ctx.db, listing.id),
    getAllLessons(ctx.db, listing.id),
    seatCounts(ctx.db, [listing.id]),
  ]);
  const problems = await publishProblems(ctx, listing, lessons);
  const settings = await ctx.settings();
  const av = availabilityOf(listing, counts.get(listing.id), ctx.now, settings.bookings_paused === '1');
  const publicUrl = `${ctx.cfg.publicOrigin}/session/${listing.slug}`;
  const changes = await ctx.db
    .prepare('SELECT * FROM lesson_changes WHERE listing_id = ? ORDER BY changed_at DESC LIMIT 20')
    .bind(listing.id)
    .all<{ id: number; lesson_id: string; change_kind: string; old_starts_at: number | null; new_starts_at: number | null; old_ends_at: number | null; new_ends_at: number | null; changed_at: number; notified_at: number | null }>();
  const active = await ctx.db
    .prepare(`SELECT * FROM bookings WHERE listing_id = ? AND status IN ${OCCUPYING_SQL}`)
    .bind(listing.id)
    .all<BookingRow>();
  const unnotified = changes.results.filter((c) => !c.notified_at);

  const statusActions = html`<div class="actions">
    ${listingBadge(listing.status)}
    <span class="badge b-idle">${av.confirmed} confirmed · ${av.held} held · ${av.left} available of ${listing.capacity}</span>
    ${listing.status === 'draft' || listing.status === 'closed' ? postButton(ctx, `/listings/${listing.id}/publish`, listing.status === 'draft' ? 'Publish' : 'Reopen bookings', { cls: 'primary' }) : ''}
    ${listing.status === 'published' ? postButton(ctx, `/listings/${listing.id}/close`, 'Close bookings', { confirm: 'Stop new bookings for this listing? Existing bookings stay.' }) : ''}
    <a class="btn small" href="/listings/${listing.id}/preview">Preview</a>
    ${listing.status !== 'draft' ? html`<a class="btn small" href="${publicUrl}" target="_blank" rel="noopener">Public page</a>` : ''}
  </div>`;

  const body = html`<h1>${listing.title}</h1>
    ${statusActions}
    ${problems.blocking.length && listing.status !== 'cancelled'
      ? html`<div class="warnbox"><strong>${listing.status === 'draft' ? 'Before you can publish:' : 'Problems:'}</strong><ul>${problems.blocking.map((p) => html`<li>${p}</li>`)}</ul></div>`
      : ''}
    ${problems.warnings.length ? html`<div class="warnbox"><strong>Warnings:</strong><ul>${problems.warnings.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    ${listing.status === 'cancelled' ? await cancelledReport(ctx, listing) : ''}

    <div class="card"><h2>Dates (UK time)</h2>
      ${table(
        ['#', 'When (UK)', 'Call link', 'Revision', ''],
        allLessons.map((l) => [
          l.status === 'scheduled' ? String(l.seq) : '—',
          html`${fmtSlotUk(l.starts_at, l.ends_at)}${l.status === 'cancelled' ? html` <span class="badge b-bad">Cancelled</span>` : ''}`,
          l.meeting_url ? html`<span class="mono">${l.meeting_url}</span>` : html`<span class="badge b-warn">missing</span>`,
          String(l.revision),
          l.status === 'scheduled' && listing.status !== 'cancelled' ? html`<a class="btn small" href="/listings/${listing.id}/lessons/${l.id}">Edit</a>` : '',
        ]),
        'No dates yet.',
      )}
      ${listing.status !== 'cancelled'
        ? html`<h3>Add a date</h3>
          ${extra.lessonError ? html`<div class="flash err">${extra.lessonError}</div>` : ''}
          <form method="post" action="/listings/${listing.id}/lessons">${csrfField(ctx)}
            ${lessonFormFields({ date: extra.lessonValues?.date, time: extra.lessonValues?.time, duration: Number(extra.lessonValues?.duration) || 60, url: extra.lessonValues?.meeting_url }, extra.ambiguous)}
            <button class="primary" type="submit">Add date</button>
          </form>`
        : ''}
    </div>

    ${unnotified.length
      ? html`<div class="card"><h2>Schedule changes not yet sent</h2>
          <p>${unnotified.length} change(s) affect ${active.results.length} student(s) with a seat.</p>
          ${table(['Changed', 'Was', 'Now', 'Kind'], unnotified.map((c) => [fmtDate(c.changed_at), c.old_starts_at && c.old_ends_at ? fmtSlotUk(c.old_starts_at, c.old_ends_at) : '—', c.new_starts_at && c.new_ends_at ? fmtSlotUk(c.new_starts_at, c.new_ends_at) : '—', c.change_kind]))}
          <h3>Affected students</h3>
          ${table(['Name', 'Email', 'Status'], active.results.map((b) => [b.first_name, b.email, b.status]))}
          ${postButton(ctx, '/messages/prepare', 'Prepare date-change email', { cls: 'primary', fields: { template: 'datechange', listing: listing.id } })}
        </div>`
      : ''}

    <div class="grid two">
      <div class="card"><h2>Details</h2>${listingForm(ctx, listing)}</div>
      <div>
        ${messagesSection(ctx, listing, unnotified.length > 0)}
        ${listing.status !== 'cancelled' ? manualBookingForm(ctx, listing) : ''}
      </div>
    </div>
    ${await rosterSection(ctx, listing)}
    ${await invitesSection(ctx, listing)}
    ${await listingWaitlistSection(ctx, listing)}
    ${listing.status !== 'cancelled' && listing.status !== 'draft'
      ? html`<div class="card"><h2>Cancel this group</h2>
          <p class="small">Stops new checkouts immediately, expires open Checkouts in Stripe, and lists the refunds and emails you need to send.</p>
          <form method="post" action="/listings/${listing.id}/cancel" data-confirm="Cancel this group for everyone? This cannot be undone.">${csrfField(ctx)}
            <div class="f"><label for="reason">Reason shown to students <span class="hint">optional</span></label><input id="reason" name="reason" type="text" maxlength="200"></div>
            <button class="danger" type="submit">Cancel group</button>
          </form></div>`
      : ''}
    ${listing.status === 'draft' ? postButton(ctx, `/listings/${listing.id}/delete`, 'Delete draft', { cls: 'danger small', confirm: 'Delete this draft?' }) : ''}`;
  return adminLayout(ctx, { title: listing.title, body });
}

async function cancelledReport(ctx: AdminCtx, listing: ListingRow): Promise<SafeHtml> {
  const rows = await ctx.db
    .prepare(`SELECT * FROM bookings WHERE listing_id = ? AND status IN ('confirmed','exception','hold','pending') ORDER BY created_at`)
    .bind(listing.id)
    .all<BookingRow>();
  const needRefund = rows.results.filter((b) => b.status === 'confirmed' && b.refund_state !== 'full' && b.source !== 'manual');
  const manual = rows.results.filter((b) => b.status === 'confirmed' && b.source === 'manual');
  const unresolved = rows.results.filter((b) => b.status !== 'confirmed');
  return html`<div class="warnbox"><h2>Cancelled ${listing.cancelled_at ? fmtDate(listing.cancelled_at) : ''}: outstanding actions</h2>
    <p><strong>${needRefund.length}</strong> paid booking(s) still need a refund in the Stripe Dashboard (then press "Sync refunds" on each booking).
    ${manual.length ? html`<strong>${manual.length}</strong> separately paid booking(s) need refunding outside Stripe.` : ''}
    ${unresolved.length ? html`<strong>${unresolved.length}</strong> checkout(s) could not be closed yet; ${postButton(ctx, `/listings/${listing.id}/settle`, 'Retry closing checkouts')}` : ''}</p>
    ${table(['Student', 'Status', 'Paid', 'Refunded', ''], [...needRefund, ...manual, ...unresolved].map((b) => [
      html`${b.first_name}<br><span class="small">${b.email}</span>`,
      b.status,
      b.amount_paid_pence !== null ? `£${(b.amount_paid_pence / 100).toFixed(2)}` : '—',
      `£${(b.refunded_pence / 100).toFixed(2)} (${b.refund_state})`,
      html`<a class="btn small" href="/bookings/${b.id}">Open</a>`,
    ]), 'Nothing outstanding.')}
    ${postButton(ctx, '/messages/prepare', 'Prepare cancellation email', { cls: 'primary', fields: { template: 'cancelled', listing: listing.id } })}
  </div>`;
}

function readSlot(ctx: AdminCtx): { ok: true; start: number; end: number; url: string | null } | { ok: false; error: string; ambiguous?: { ts: number; offsetMinutes: number; zone: string }[] } {
  const date = field(ctx, 'date');
  const time = field(ctx, 'time');
  const duration = Number(field(ctx, 'duration'));
  const url = field(ctx, 'meeting_url') || null;
  const offsetRaw = field(ctx, 'offset');
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) return { ok: false, error: 'Length must be 15–480 minutes.' };
  if (url && !isHttpsUrl(url)) return { ok: false, error: 'The call link must be a full https:// address.' };
  const conv = ukLocalToUtc(date, time, offsetRaw === '' ? undefined : Number(offsetRaw));
  if (!conv.ok) {
    return { ok: false, error: conv.message, ambiguous: conv.reason === 'ambiguous' ? conv.options : undefined };
  }
  return { ok: true, start: conv.ts, end: conv.ts + duration * 60, url };
}

export async function handleAddLesson(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  if (listing.status === 'cancelled') return back(`/listings/${listing.id}`, { err: 'This listing is cancelled.' });
  const slot = readSlot(ctx);
  const values = { date: field(ctx, 'date'), time: field(ctx, 'time'), duration: field(ctx, 'duration'), meeting_url: field(ctx, 'meeting_url') };
  if (!slot.ok) return renderListingPage(ctx, listing, { lessonError: slot.error, lessonValues: values, ambiguous: slot.ambiguous });
  if (slot.start <= ctx.now) return renderListingPage(ctx, listing, { lessonError: 'That time is in the past.', lessonValues: values });
  const clashes = await findClashes(ctx.db, listing, [{ id: null, starts_at: slot.start, ends_at: slot.end }]);
  const live = listing.status === 'published' || listing.status === 'closed';
  const blocking = clashes.filter((c) => c.bookable && (live || c.otherListingId === listing.id));
  if (blocking.length) {
    return renderListingPage(ctx, listing, { lessonError: `Clash with "${blocking[0]!.otherTitle}" at ${fmtTimeRange(blocking[0]!.starts_at, blocking[0]!.ends_at)}. Choose another time.`, lessonValues: values });
  }
  const id = randomId('les', 12);
  await ctx.db.batch([
    ctx.db
      .prepare(`INSERT INTO lessons (id, listing_id, starts_at, ends_at, meeting_url, uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, listing.id, slot.start, slot.end, slot.url, `${id}@kingston-tutoring`, ctx.now, ctx.now),
    ...refreshScheduleStatements(ctx.db, listing.id, ctx.now),
    auditStatement(ctx.db, ctx.email, 'lesson_added', 'listing', listing.id, { lesson: id, starts_at: slot.start }, ctx.now),
  ]);
  if ((await activeBookingCount(ctx.db, listing.id)) > 0) {
    await ctx.db
      .prepare(`INSERT INTO lesson_changes (lesson_id, listing_id, change_kind, new_starts_at, new_ends_at, changed_at, actor) VALUES (?, ?, 'added', ?, ?, ?, ?)`)
      .bind(id, listing.id, slot.start, slot.end, ctx.now, ctx.email)
      .run();
  }
  const warn = clashes.length ? ` Note: overlaps draft "${clashes[0]!.otherTitle}".` : '';
  return back(`/listings/${listing.id}`, { ok: `Date added: ${fmtSlotUk(slot.start, slot.end)}.${warn}` });
}

export async function renderLessonEdit(ctx: AdminCtx, listing: ListingRow, lesson: LessonRow, opts: { error?: string; ambiguous?: { ts: number; offsetMinutes: number; zone: string }[]; values?: Record<string, string> } = {}): Promise<Response> {
  const affected = await activeBookingCount(ctx.db, listing.id);
  const v = opts.values;
  return adminLayout(ctx, {
    title: 'Edit date',
    status: opts.error ? 422 : 200,
    body: html`<h1>Edit date: ${listing.title}</h1>
      <p>Currently <strong>${fmtSlotUk(lesson.starts_at, lesson.ends_at)}</strong> (revision ${lesson.revision}).</p>
      ${affected ? html`<div class="warnbox">${affected} student(s) hold a seat. Changing the time or link records a schedule change, updates their calendar file and prepares a date-change email for you to send.</div>` : ''}
      ${opts.error ? html`<div class="flash err">${opts.error}</div>` : ''}
      <div class="card"><form method="post" action="/listings/${listing.id}/lessons/${lesson.id}">${csrfField(ctx)}
        ${lessonFormFields({ date: v?.date ?? toDateInput(lesson.starts_at), time: v?.time ?? toTimeInput(lesson.starts_at), duration: Number(v?.duration) || Math.round((lesson.ends_at - lesson.starts_at) / 60), url: v?.meeting_url ?? lesson.meeting_url ?? '' }, opts.ambiguous)}
        <button class="primary" type="submit">Save date</button> <a href="/listings/${listing.id}">Back</a>
      </form></div>
      <div class="card"><h2>Remove this date</h2>
        ${affected
          ? html`<p class="small">Students hold seats, so the date is marked cancelled (kept in their calendar as cancelled) rather than deleted.</p>${postButton(ctx, `/listings/${listing.id}/lessons/${lesson.id}/cancel`, 'Cancel this date', { cls: 'danger small', confirm: 'Cancel this date for all booked students?' })}`
          : postButton(ctx, `/listings/${listing.id}/lessons/${lesson.id}/cancel`, 'Delete this date', { cls: 'danger small', confirm: 'Delete this date?' })}
      </div>`,
  });
}

export async function handleUpdateLesson(ctx: AdminCtx, listing: ListingRow, lesson: LessonRow): Promise<Response> {
  const values = { date: field(ctx, 'date'), time: field(ctx, 'time'), duration: field(ctx, 'duration'), meeting_url: field(ctx, 'meeting_url') };
  const slot = readSlot(ctx);
  if (!slot.ok) return renderLessonEdit(ctx, listing, lesson, { error: slot.error, ambiguous: slot.ambiguous, values });
  const timeChanged = slot.start !== lesson.starts_at || slot.end !== lesson.ends_at;
  const linkChanged = (slot.url ?? null) !== (lesson.meeting_url ?? null);
  if (!timeChanged && !linkChanged) return back(`/listings/${listing.id}`, { ok: 'No changes.' });
  if (timeChanged && slot.start <= ctx.now) return renderLessonEdit(ctx, listing, lesson, { error: 'That time is in the past.', values });
  if (timeChanged) {
    const clashes = await findClashes(ctx.db, listing, [{ id: lesson.id, starts_at: slot.start, ends_at: slot.end }]);
    const live = listing.status === 'published' || listing.status === 'closed';
    const blocking = clashes.filter((c) => c.bookable && (live || c.otherListingId === listing.id));
    if (blocking.length) return renderLessonEdit(ctx, listing, lesson, { error: `Clash with "${blocking[0]!.otherTitle}". Choose another time.`, values });
  }
  const affected = await activeBookingCount(ctx.db, listing.id);
  const stmts = [
    ctx.db
      .prepare('UPDATE lessons SET starts_at = ?, ends_at = ?, meeting_url = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .bind(slot.start, slot.end, slot.url, ctx.now, lesson.id),
    ...refreshScheduleStatements(ctx.db, listing.id, ctx.now),
    auditStatement(ctx.db, ctx.email, 'lesson_updated', 'listing', listing.id, { lesson: lesson.id, from: lesson.starts_at, to: slot.start, linkChanged }, ctx.now),
  ];
  if (affected > 0) {
    stmts.push(
      ctx.db
        .prepare(
          `INSERT INTO lesson_changes (lesson_id, listing_id, change_kind, old_starts_at, old_ends_at, new_starts_at, new_ends_at, changed_at, actor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(lesson.id, listing.id, timeChanged ? 'time' : 'link', lesson.starts_at, lesson.ends_at, slot.start, slot.end, ctx.now, ctx.email),
    );
  }
  await ctx.db.batch(stmts);
  return back(`/listings/${listing.id}`, {
    ok: affected > 0 ? `Saved. ${affected} student(s) affected: send the date-change email below.` : 'Saved.',
  });
}

export async function handleCancelLesson(ctx: AdminCtx, listing: ListingRow, lesson: LessonRow): Promise<Response> {
  const affected = await activeBookingCount(ctx.db, listing.id);
  if (affected === 0) {
    await ctx.db.batch([
      ctx.db.prepare('DELETE FROM lesson_changes WHERE lesson_id = ?').bind(lesson.id),
      ctx.db.prepare('DELETE FROM lessons WHERE id = ?').bind(lesson.id),
      ...refreshScheduleStatements(ctx.db, listing.id, ctx.now),
      auditStatement(ctx.db, ctx.email, 'lesson_deleted', 'listing', listing.id, { lesson: lesson.id }, ctx.now),
    ]);
    return back(`/listings/${listing.id}`, { ok: 'Date deleted.' });
  }
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE lessons SET status = 'cancelled', revision = revision + 1, updated_at = ? WHERE id = ?`).bind(ctx.now, lesson.id),
    ctx.db
      .prepare(`INSERT INTO lesson_changes (lesson_id, listing_id, change_kind, old_starts_at, old_ends_at, changed_at, actor) VALUES (?, ?, 'cancelled', ?, ?, ?, ?)`)
      .bind(lesson.id, listing.id, lesson.starts_at, lesson.ends_at, ctx.now, ctx.email),
    ...refreshScheduleStatements(ctx.db, listing.id, ctx.now),
    auditStatement(ctx.db, ctx.email, 'lesson_cancelled', 'listing', listing.id, { lesson: lesson.id }, ctx.now),
  ]);
  return back(`/listings/${listing.id}`, { ok: `Date cancelled. ${affected} student(s) affected: send the date-change email and refund that session if needed.` });
}

export async function handlePublish(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  if (listing.status !== 'draft' && listing.status !== 'closed') return back(`/listings/${listing.id}`, { err: 'Only drafts or closed listings can be published.' });
  const lessons = await getLessons(ctx.db, listing.id);
  const problems = await publishProblems(ctx, listing, lessons);
  if (problems.blocking.length) return back(`/listings/${listing.id}`, { err: `Not published: ${problems.blocking.join(' ')}` });
  await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE listings SET status = 'published', published_at = COALESCE(published_at, ?), closed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('draft','closed')`)
      .bind(ctx.now, ctx.now, listing.id),
    auditStatement(ctx.db, ctx.email, 'listing_published', 'listing', listing.id, null, ctx.now),
  ]);
  return back(`/listings/${listing.id}`, { ok: 'Published. It is now on the public site.' });
}

export async function handleClose(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE listings SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'published'`).bind(ctx.now, ctx.now, listing.id),
    auditStatement(ctx.db, ctx.email, 'listing_closed', 'listing', listing.id, null, ctx.now),
  ]);
  return back(`/listings/${listing.id}`, { ok: 'Bookings closed. Existing bookings are unaffected.' });
}

export async function handleCancelListing(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  if (listing.status === 'cancelled') return back(`/listings/${listing.id}`, { err: 'Already cancelled.' });
  const report = await cancelListing(ctx.deps(), listing.id, cleanText(field(ctx, 'reason'), 200), ctx.email);
  return back(`/listings/${listing.id}`, {
    ok: `Group cancelled. ${report.releasedUnpaid} unpaid checkout(s) closed; ${report.confirmed.length} paid student(s) need a refund; ${report.unresolved.length} unresolved.`,
  });
}

export async function handleSettle(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const report = await settleCancelledListing(ctx.deps(), listing.id);
  return back(`/listings/${listing.id}`, { ok: `Retried: ${report.releasedUnpaid} closed, ${report.unresolved.length} still unresolved.` });
}

export async function handleDeleteDraft(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  if (listing.status !== 'draft') return back(`/listings/${listing.id}`, { err: 'Only drafts can be deleted.' });
  const any = await ctx.db.prepare('SELECT id FROM bookings WHERE listing_id = ? LIMIT 1').bind(listing.id).first();
  if (any) return back(`/listings/${listing.id}`, { err: 'This draft has bookings and cannot be deleted.' });
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM lesson_changes WHERE listing_id = ?').bind(listing.id),
    ctx.db.prepare('DELETE FROM lessons WHERE listing_id = ?').bind(listing.id),
    ctx.db.prepare('DELETE FROM invites WHERE listing_id = ?').bind(listing.id),
    ctx.db.prepare('DELETE FROM listings WHERE id = ?').bind(listing.id),
    auditStatement(ctx.db, ctx.email, 'listing_deleted', 'listing', listing.id, { title: listing.title }, ctx.now),
  ]);
  return redirect('/?ok=Draft%20deleted.', { private: true });
}

export async function renderPreview(ctx: AdminCtx, listing: ListingRow): Promise<Response> {
  const settings = await ctx.settings();
  const lessons = await getLessons(ctx.db, listing.id);
  const counts = await seatCounts(ctx.db, [listing.id]);
  const av = availabilityOf({ ...listing, status: listing.status === 'draft' ? 'published' : listing.status }, counts.get(listing.id), ctx.now, false);
  const view = { listing, lessons, availability: av };
  const body = html`<div class="welcome"><div class="wrap">Preview only · <a href="/listings/${listing.id}">Back to the dashboard</a></div></div>
    <section class="hero on-dark"><div class="wrap hero-grid"><div><h1>Get unstuck on Python test questions.</h1><p class="lede">Preview of the booking card and dates as students will see them.</p></div><div>${bookingCard(view)}</div></div></section>
    <div class="page"><div class="wrap narrow"><h2>All dates</h2>${dateList(lessons)}</div></div>`;
  const page = publicLayout({ cfg: ctx.cfg, settings, title: `Preview: ${listing.title}`, body, noindex: true });
  return new Response('<!doctype html>' + String(page), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function loadListingOr404(ctx: AdminCtx, id: string): Promise<ListingRow | null> {
  return /^lst_[a-z0-9]{6,32}$/.test(id) ? getListing(ctx.db, id) : null;
}

