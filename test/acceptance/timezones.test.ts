/**
 * Acceptance: "GMT/BST boundary and a rescheduled date → agenda, Checkout, confirmation and ICS show
 * matching times."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminClient, type Client, type TestApp, startApp } from '../helpers/app';
import { parseStripeForm } from '../helpers/fake-stripe';
import {
  addDays,
  book,
  bookingIdForEmail,
  checkoutSessionId,
  dateKey,
  extract,
  flash,
  nextClockChange,
  pageText,
} from '../helpers/flows';
import { icsUtc } from '../../src/shared/ics';

const utc = (d: Date, h: number, m = 0) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) / 1000;

describe('UK time across the clock change', () => {
  let app: TestApp;
  let admin: AdminClient;
  let student: Client;
  let listingId: string;
  let slug: string;
  const spring = nextClockChange('spring'); // Sunday when 01:00 GMT becomes 02:00 BST
  const before = addDays(spring, -3); // Thursday in GMT
  const after = addDays(spring, 4); // Thursday in BST
  let lesson2Id: string;
  let bookingId: string;

  beforeAll(async () => {
    app = await startApp();
    admin = app.admin();
    student = app.student();
  });
  afterAll(async () => app?.close());

  it('converts UK wall-clock input to UTC on both sides of the change', async () => {
    const created = await admin.act('/listings', { title: 'Clock change group', topic: 'Python test questions', slug: 'clock-change', kind: 'package', price: '80', capacity: '8', cutoff_minutes: '120', format: 'Online' });
    expect(created.status).toBe(303);
    listingId = extract(created.headers.get('Location')!, /\/listings\/(lst_[a-z0-9]+)/);
    slug = 'clock-change';
    for (const [d, n] of [[before, 1], [after, 2]] as const) {
      const res = await admin.act(`/listings/${listingId}/lessons`, { date: dateKey(d), time: '18:00', duration: '60', meeting_url: `https://meet.example.com/tz-${n}` });
      expect(res.status, await pageText(res)).toBe(303);
    }
    const rows = await app.db.prepare('SELECT id, starts_at, ends_at FROM lessons WHERE listing_id = ? ORDER BY starts_at').bind(listingId).all<{ id: string; starts_at: number; ends_at: number }>();
    expect(rows.results.map((r) => r.starts_at)).toEqual([utc(before, 18), utc(after, 17)]); // 18:00 GMT, 18:00 BST
    lesson2Id = rows.results[1]!.id;
  });

  it('rejects a time that does not exist and asks which one is meant for a repeated time', async () => {
    const gap = await admin.act(`/listings/${listingId}/lessons`, { date: dateKey(spring), time: '01:30', duration: '60', meeting_url: 'https://meet.example.com/x' });
    expect(gap.status).toBe(200);
    expect(await pageText(gap)).toContain('does not exist in the UK: the clocks go forward that night');

    const draft = await admin.act('/listings', { title: 'Autumn test', topic: 'Python', slug: 'autumn-test', kind: 'single', price: '15', capacity: '8', cutoff_minutes: '120' });
    const draftId = extract(draft.headers.get('Location')!, /\/listings\/(lst_[a-z0-9]+)/);
    const autumn = nextClockChange('autumn');
    const ask = await admin.act(`/listings/${draftId}/lessons`, { date: dateKey(autumn), time: '01:30', duration: '30', meeting_url: 'https://meet.example.com/a' });
    const askText = await pageText(ask);
    expect(askText).toContain('happens twice in the UK');
    expect(askText).toContain('name="offset" value="60"');
    expect(askText).toContain('name="offset" value="0"');
    await admin.act(`/listings/${draftId}/lessons`, { date: dateKey(autumn), time: '01:30', duration: '30', meeting_url: 'https://meet.example.com/a', offset: '60' });
    const first = await app.db.prepare('SELECT starts_at FROM lessons WHERE listing_id = ?').bind(draftId).first<{ starts_at: number }>();
    expect(first!.starts_at).toBe(utc(autumn, 0, 30)); // first 01:30 is BST = 00:30 UTC
    const second = await admin.act(`/listings/${draftId}/lessons`, { date: dateKey(autumn), time: '03:00', duration: '30', meeting_url: 'https://meet.example.com/b' });
    expect(second.status).toBe(303);
  });

  it('shows matching times on the agenda, Checkout, confirmation and ICS', async () => {
    const published = await admin.act(`/listings/${listingId}/publish`);
    expect(flash(published)).toContain('Published');
    const gmtWeek = await pageText(await student.get(`/calendar?week=${dateKey(before)}`));
    expect(gmtWeek).toContain('18:00–19:00 GMT');
    const bstWeek = await pageText(await student.get(`/calendar?week=${dateKey(after)}`));
    expect(bstWeek).toContain('18:00–19:00 BST');

    const res = await book(student, slug, { email: 'tz@example.com', firstName: 'Tom' });
    const sessionId = checkoutSessionId(res);
    bookingId = await bookingIdForEmail(app.db, 'tz@example.com');
    const description = parseStripeForm(app.stripe.sessions.get(sessionId)!.raw_body).line_items[0].price_data.product_data.description as string;
    expect(description).toMatch(/18:00–19:00 UK time \(GMT\).*18:00–19:00 UK time \(BST\)/);

    app.stripe.pay(sessionId);
    await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
    const page = await pageText(await student.get(`/booking/${bookingId}`));
    expect(page).toContain('18:00–19:00 UK time (GMT)');
    expect(page).toContain('18:00–19:00 UK time (BST)');
    const ics = await (await student.get(`/booking/${bookingId}/calendar.ics`)).text();
    expect(ics).toContain(`DTSTART:${icsUtc(utc(before, 18))}`);
    expect(ics).toContain(`DTSTART:${icsUtc(utc(after, 17))}`);
  });

  it('a rescheduled date updates every view, bumps the ICS sequence and lists affected students', async () => {
    const res = await admin.act(`/listings/${listingId}/lessons/${lesson2Id}`, { date: dateKey(after), time: '19:00', duration: '60', meeting_url: 'https://meet.example.com/tz-2' });
    expect(flash(res)).toContain('1 student(s) affected');
    const lesson = await app.db.prepare('SELECT starts_at, revision, uid FROM lessons WHERE id = ?').bind(lesson2Id).first<{ starts_at: number; revision: number; uid: string }>();
    expect(lesson).toMatchObject({ starts_at: utc(after, 18), revision: 1 });

    const listingPage = await pageText(await admin.get(`/listings/${listingId}`));
    expect(listingPage).toContain('Schedule changes not yet sent');
    expect(listingPage).toContain('tz@example.com');
    const email = await pageText(await admin.act('/messages/prepare', { template: 'datechange', listing: listingId }));
    expect(email).toContain('18:00–19:00 UK time (BST), now');
    expect(email).toContain('19:00–20:00 UK time (BST)');
    expect(email).toContain('1 recipient(s): tz@example.com');
    const changeIds = extract(email, /name="change_ids" value="([0-9,]+)"/);
    await admin.act('/messages/sent', { template: 'datechange', listing: listingId, recipients: '1', subject_sent: 'Date change', change_ids: changeIds });
    const pending = await app.db.prepare('SELECT COUNT(*) AS n FROM lesson_changes WHERE listing_id = ? AND notified_at IS NULL').bind(listingId).first<{ n: number }>();
    expect(pending!.n).toBe(0);

    const page = await pageText(await student.get(`/booking/${bookingId}`));
    expect(page).toContain('19:00–20:00 UK time (BST)');
    expect(page).not.toContain('18:00–19:00 UK time (BST)');
    const agenda = await pageText(await student.get(`/calendar?week=${dateKey(after)}`));
    expect(agenda).toContain('19:00–20:00 BST');
    const ics = await (await student.get(`/booking/${bookingId}/calendar.ics`)).text();
    const event2 = ics.split('BEGIN:VEVENT')[2]!;
    expect(event2).toContain(`UID:${lesson!.uid}`);
    expect(event2).toContain('SEQUENCE:1');
    expect(event2).toContain(`DTSTART:${icsUtc(utc(after, 18))}`);

    const next = app.student();
    const sessionId = checkoutSessionId(await book(next, slug, { email: 'tz2@example.com' }));
    const description = parseStripeForm(app.stripe.sessions.get(sessionId)!.raw_body).line_items[0].price_data.product_data.description as string;
    expect(description).toContain('19:00–20:00 UK time (BST)');
  });
});
