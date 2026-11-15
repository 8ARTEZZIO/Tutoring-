import { issueAccessToken } from '../../shared/access';
import { randomId } from '../../shared/crypto';
import { type BookingRow, type ListingRow, OCCUPYING_SQL, audit, getBooking, getLessons, getListing } from '../../shared/db';
import { fmtMoney } from '../../shared/format';
import { type SafeHtml, html } from '../../shared/html';
import { fillTemplate } from '../../shared/settings';
import { fmtSlotUk } from '../../shared/time';
import { type AdminCtx, field } from '../context';
import { adminLayout, back, csrfField, postButton } from '../ui';

type TemplateKey = 'confirmation' | 'reminder' | 'datechange' | 'refund' | 'cancelled' | 'waitlist';
const TEMPLATES: TemplateKey[] = ['confirmation', 'reminder', 'datechange', 'refund', 'cancelled', 'waitlist'];

export function messagesSection(ctx: AdminCtx, listing: ListingRow, hasChanges: boolean): SafeHtml {
  const btn = (template: TemplateKey, label: string) =>
    postButton(ctx, '/messages/prepare', label, { fields: { template, listing: listing.id } });
  return html`<div class="card"><h2>Emails to students</h2>
    <p class="small muted">Prepared here, sent from your own mailbox. Group emails use BCC. Mark each one as sent once you've sent it.</p>
    <div class="actions">
      ${btn('reminder', 'Reminder (BCC)')}
      ${hasChanges ? btn('datechange', 'Date change (BCC)') : ''}
      ${listing.status === 'cancelled' ? btn('cancelled', 'Cancellation (BCC)') : ''}
      ${btn('waitlist', 'Seat opening alert (BCC waitlist)')}
    </div>
    <p class="small muted">Confirmation and refund emails are prepared per student from their booking page.</p></div>`;
}

async function baseValues(ctx: AdminCtx, listing: ListingRow, booking?: BookingRow): Promise<Record<string, string>> {
  const s = await ctx.settings();
  const lessons = await getLessons(ctx.db, listing.id);
  const next = lessons.find((l) => l.ends_at > ctx.now) ?? lessons[0];
  return {
    listing_title: listing.title,
    dates: lessons.map((l) => `- ${fmtSlotUk(l.starts_at, l.ends_at)}`).join('\n'),
    price: fmtMoney(booking?.price_pence ?? listing.price_pence, listing.currency),
    next_date: next ? fmtSlotUk(next.starts_at, next.ends_at) : 'to be confirmed',
    what_to_bring: s.what_to_bring,
    seller_name: s.seller_name || s.tutor_first_name,
    contact_email: s.seller_email,
    calendar_link: `${ctx.cfg.publicOrigin}/calendar`,
    cancel_reason: listing.cancel_reason ? `Reason: ${listing.cancel_reason}` : '',
    cancellation_info: s.cancellation_summary,
    first_name: booking?.first_name ?? '',
    booking_id: booking?.id ?? '',
    refund_amount: booking ? fmtMoney(booking.refunded_pence, booking.currency) : '',
    booking_link: `${ctx.cfg.publicOrigin}/session/${listing.slug}?ref=waitlist`,
  };
}

interface Draft {
  template: TemplateKey;
  subject: string;
  body: string;
  to: string[];
  bcc: string[];
  listingId: string | null;
  bookingId: string | null;
  marks: Record<string, string>;
}

function mailtoHref(d: Draft): string {
  const q = [
    ...(d.bcc.length ? [`bcc=${encodeURIComponent(d.bcc.join(','))}`] : []),
    `subject=${encodeURIComponent(d.subject)}`,
    `body=${encodeURIComponent(d.body)}`,
  ];
  return `mailto:${d.to.map((t) => encodeURIComponent(t).replace(/%40/g, '@')).join(',')}?${q.join('&')}`;
}

function gmailHref(d: Draft): string {
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(d.to.join(','))}&bcc=${encodeURIComponent(d.bcc.join(','))}&su=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
}

export function editor(ctx: AdminCtx, d: Draft): SafeHtml {
  const recipients = d.to.length + d.bcc.length;
  const long = mailtoHref(d).length > 1900;
  return html`<div class="card" data-mail-editor data-to="${d.to.join(',')}" data-bcc="${d.bcc.join(',')}">
    <h2>${d.template[0]!.toUpperCase() + d.template.slice(1)} email</h2>
    <dl class="kv small"><dt>To</dt><dd>${d.to.join(', ') || '—'}</dd><dt>BCC</dt><dd>${d.bcc.length ? `${d.bcc.length} recipient(s): ${d.bcc.join(', ')}` : '—'}</dd></dl>
    ${recipients === 0 ? html`<div class="warnbox">No recipients for this email.</div>` : ''}
    <div class="f"><label for="subject">Subject</label><input id="subject" name="subject" type="text" value="${d.subject}"></div>
    <div class="f"><label for="body">Message</label><textarea id="body" name="body" class="tall">${d.body}</textarea></div>
    <div class="actions">
      <a class="btn primary" data-mailto href="${mailtoHref(d)}">Open in mail app</a>
      <a class="btn" data-gmail href="${gmailHref(d)}" target="_blank" rel="noopener noreferrer">Open in Gmail</a>
      <button type="button" data-copy="body" hidden>Copy message</button>
    </div>
    ${long ? html`<p class="small muted">This message is long; some mail apps truncate long links. If so, use Copy and paste it into a new email.</p>` : ''}
    <form method="post" action="/messages/sent" class="actions">${csrfField(ctx)}
      <input type="hidden" name="template" value="${d.template}">
      <input type="hidden" name="listing" value="${d.listingId ?? ''}">
      <input type="hidden" name="booking" value="${d.bookingId ?? ''}">
      <input type="hidden" name="recipients" value="${String(recipients)}">
      <input type="hidden" name="subject_sent" value="${d.subject}">
      ${Object.entries(d.marks).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <button type="submit">I've sent it: mark as sent</button>
    </form>
  </div>`;
}

export async function prepareConfirmation(ctx: AdminCtx, booking: BookingRow, listing: ListingRow, link: string): Promise<SafeHtml> {
  const s = await ctx.settings();
  const values = { ...(await baseValues(ctx, listing, booking)), booking_link: link };
  return editor(ctx, {
    template: 'confirmation',
    subject: fillTemplate(s.tpl_confirmation_subject, values),
    body: fillTemplate(s.tpl_confirmation_body, values),
    to: [booking.email],
    bcc: [],
    listingId: listing.id,
    bookingId: booking.id,
    marks: {},
  });
}

export async function handlePrepare(ctx: AdminCtx): Promise<Response> {
  const template = field(ctx, 'template') as TemplateKey;
  if (!TEMPLATES.includes(template)) return back('/', { err: 'Unknown template.' });
  const s = await ctx.settings();
  const bookingId = field(ctx, 'booking');
  const booking = bookingId ? await getBooking(ctx.db, bookingId) : null;
  const listing = await getListing(ctx.db, booking?.listing_id ?? field(ctx, 'listing'));
  if (!listing) return back('/', { err: 'Listing not found.' });
  const values = await baseValues(ctx, listing, booking ?? undefined);
  const subjectKey = `tpl_${template}_subject` as const;
  const bodyKey = `tpl_${template}_body` as const;
  let to: string[] = [];
  let bcc: string[] = [];
  const marks: Record<string, string> = {};

  if (template === 'confirmation' || template === 'refund') {
    if (!booking) return back(`/listings/${listing.id}`, { err: 'Choose a booking first.' });
    to = [booking.email];
    if (template === 'confirmation') {
      if (booking.status !== 'confirmed') return back(`/bookings/${booking.id}`, { err: 'Only confirmed bookings get a confirmation email.' });
      const token = await issueAccessToken(ctx.db, booking.id, 'link', ctx.email, ctx.now);
      values.booking_link = `${ctx.cfg.publicOrigin}/b/${token}`;
      await audit(ctx.db, ctx.email, 'private_link_issued', 'booking', booking.id, { for: 'confirmation' }, ctx.now);
    }
  } else if (template === 'waitlist') {
    const rows = await ctx.db
      .prepare(`SELECT id, email FROM waitlist WHERE (listing_key = ? OR listing_key = 'any') AND wants_seat_alert = 1 AND left_at IS NULL ORDER BY created_at`)
      .bind(listing.id)
      .all<{ id: string; email: string }>();
    bcc = [...new Set(rows.results.map((r) => r.email))];
    marks.waitlist_ids = rows.results.map((r) => r.id).join(',');
  } else {
    const statuses = template === 'datechange' ? OCCUPYING_SQL : `('confirmed','exception')`;
    const rows = await ctx.db
      .prepare(`SELECT email FROM bookings WHERE listing_id = ? AND status IN ${statuses} ORDER BY created_at`)
      .bind(listing.id)
      .all<{ email: string }>();
    bcc = [...new Set(rows.results.map((r) => r.email))];
    if (template === 'datechange') {
      const changes = await ctx.db
        .prepare('SELECT * FROM lesson_changes WHERE listing_id = ? AND notified_at IS NULL ORDER BY changed_at')
        .bind(listing.id)
        .all<{ id: number; change_kind: string; old_starts_at: number | null; old_ends_at: number | null; new_starts_at: number | null; new_ends_at: number | null }>();
      values.changes = changes.results
        .map((c) => {
          const was = c.old_starts_at && c.old_ends_at ? fmtSlotUk(c.old_starts_at, c.old_ends_at) : null;
          const now = c.new_starts_at && c.new_ends_at ? fmtSlotUk(c.new_starts_at, c.new_ends_at) : null;
          if (c.change_kind === 'cancelled') return `- Cancelled: ${was}`;
          if (c.change_kind === 'added') return `- New date added: ${now}`;
          if (c.change_kind === 'link') return `- New call link for ${now} (see your booking page)`;
          return `- Was ${was}, now ${now}`;
        })
        .join('\n');
      marks.change_ids = changes.results.map((c) => String(c.id)).join(',');
    }
  }
  const draft: Draft = {
    template,
    subject: fillTemplate(s[subjectKey], values),
    body: fillTemplate(s[bodyKey], values),
    to,
    bcc,
    listingId: listing.id,
    bookingId: booking?.id ?? null,
    marks,
  };
  return adminLayout(ctx, {
    title: 'Prepare email',
    body: html`<p><a href="${booking ? `/bookings/${booking.id}` : `/listings/${listing.id}`}">← Back</a></p>
      ${template === 'confirmation' ? html`<div class="flash">A new private link was created for this email. Older links keep working until you revoke them.</div>` : ''}
      ${editor(ctx, draft)}`,
  });
}

export async function handleMarkSent(ctx: AdminCtx): Promise<Response> {
  const template = field(ctx, 'template') as TemplateKey;
  if (!TEMPLATES.includes(template)) return back('/', { err: 'Unknown template.' });
  const listingId = field(ctx, 'listing') || null;
  const bookingId = field(ctx, 'booking') || null;
  const recipients = Math.max(0, Number(field(ctx, 'recipients')) || 0);
  const stmts: D1PreparedStatement[] = [
    ctx.db
      .prepare('INSERT INTO messages (id, template, listing_id, booking_id, recipients, subject, marked_sent_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(randomId('msg', 12), template, listingId, bookingId, recipients, field(ctx, 'subject_sent').slice(0, 300), ctx.now, ctx.email),
  ];
  const changeIds = field(ctx, 'change_ids').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  for (const id of changeIds) {
    stmts.push(ctx.db.prepare('UPDATE lesson_changes SET notified_at = ? WHERE id = ? AND listing_id = ?').bind(ctx.now, id, listingId));
  }
  const waitIds = field(ctx, 'waitlist_ids').split(',').filter((x) => /^wl_[a-z0-9]+$/.test(x));
  for (const id of waitIds) stmts.push(ctx.db.prepare('UPDATE waitlist SET alert_sent_at = ? WHERE id = ?').bind(ctx.now, id));
  await ctx.db.batch(stmts);
  await audit(ctx.db, ctx.email, 'message_marked_sent', bookingId ? 'booking' : 'listing', bookingId ?? listingId, { template, recipients }, ctx.now);
  return back(bookingId ? `/bookings/${bookingId}` : listingId ? `/listings/${listingId}` : '/', { ok: `Marked "${template}" as sent to ${recipients} recipient(s).` });
}
