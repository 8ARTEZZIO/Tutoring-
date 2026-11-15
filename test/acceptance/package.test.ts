/**
 * Acceptance: "Four-date package → one payment covers one seat on all four dates and the ICS contains
 * four events."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, type TestApp, startApp } from '../helpers/app';
import { DAY, book, bookingIdForEmail, checkoutSessionId, nowSec, occupied, openForm, pageText, seedListing } from '../helpers/flows';
import { fmtSlotUk, mondayOfKey, ukDateKey } from '../../src/shared/time';
import { icsUtc } from '../../src/shared/ics';
import { parseStripeForm } from '../helpers/fake-stripe';

describe('four-date package', () => {
  let app: TestApp;
  let pkg: { id: string; slug: string; lessonIds: string[] };
  let starts: number[];
  let student: Client;
  let bookingId: string;
  let sessionId: string;

  beforeAll(async () => {
    app = await startApp();
    const base = nowSec() + 30 * DAY;
    starts = [0, 7, 14, 21].map((d) => base + d * DAY);
    pkg = await seedListing(app.db, {
      slug: 'first-four-week',
      title: 'First four-session group',
      kind: 'package',
      price: 8000,
      capacity: 8,
      lessons: starts.map((start) => ({ start, minutes: 60 })),
    });
    student = app.student();
  });
  afterAll(async () => app?.close());

  it('shows all four dates and the full total before payment', async () => {
    const { html } = await openForm(student, pkg.slug);
    for (const s of starts) expect(html).toContain(fmtSlotUk(s, s + 3600).split(', ')[0]!);
    expect(html).toContain('£80 <small>total for all 4 sessions</small>');
    expect(html).toContain('One payment of £80 books one seat for you on all 4 dates above.');
    expect(html).toContain('Session 4 of 4');
    expect(html).toContain('Continue to payment · £80');
  });

  it('labels the dates as one package on the calendar', async () => {
    const week = mondayOfKey(ukDateKey(starts[1]!));
    const html = await (await app.student().get(`/calendar?week=${week}`)).text();
    expect(html).toContain('Package · session 2 of 4. One booking covers all 4 dates.');
  });

  it('charges one payment of £80 for one seat on every date', async () => {
    const res = await book(student, pkg.slug, { email: 'pkg@example.com', firstName: 'Ada' });
    expect(res.status).toBe(303);
    sessionId = checkoutSessionId(res);
    bookingId = await bookingIdForEmail(app.db, 'pkg@example.com');
    const created = app.stripe.sessions.get(sessionId)!;
    expect(created.amount_total).toBe(8000);
    expect(created.currency).toBe('gbp');
    const params = parseStripeForm(created.raw_body);
    expect(params.line_items).toHaveLength(1);
    expect(params.line_items[0].quantity).toBe('1');
    expect(params.line_items[0].price_data.product_data.name).toBe('First four-session group (4 sessions)');
    for (const s of starts) expect(params.line_items[0].price_data.product_data.description).toContain(fmtSlotUk(s, s + 3600));
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.metadata.booking_id).toBe(bookingId);
    expect(Number(params.expires_at) - (await app.db.prepare('SELECT created_at FROM bookings WHERE id = ?').bind(bookingId).first<{ created_at: number }>())!.created_at).toBe(40 * 60);
    expect(await occupied(app.db, pkg.id)).toBe(1);

    app.stripe.pay(sessionId);
    const hook = await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
    expect(hook.status).toBe(200);
    const row = await app.db.prepare('SELECT status, price_pence, amount_paid_pence FROM bookings WHERE id = ?').bind(bookingId).first();
    expect(row).toEqual({ status: 'confirmed', price_pence: 8000, amount_paid_pence: 8000 });
    // One seat across the whole package.
    expect(await occupied(app.db, pkg.id)).toBe(1);
    const page = await (await app.student().get(`/session/${pkg.slug}`)).text();
    expect(page).toContain('7 of 8 seats left');
  });

  it('confirms on return and shows every date with its call link', async () => {
    const ret = await student.get(`/checkout/return?b=${bookingId}&session_id=${sessionId}`);
    expect(ret.status).toBe(303);
    expect(ret.headers.get('Location')).toBe(`/booking/${bookingId}?welcome=1`);
    const html = await pageText(await student.follow(ret));
    expect(html).toContain("You're booked!");
    expect(html).toContain('for all 4 dates');
    for (let i = 1; i <= 4; i++) expect(html).toContain(`https://meet.example.com/first-four-week-${i}`);
  });

  it('exports an ICS file with four events, stable UIDs and UTC times', async () => {
    const res = await student.get(`/booking/${bookingId}/calendar.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/calendar');
    const ics = await res.text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    for (const [i, s] of starts.entries()) {
      expect(ics).toContain(`UID:${pkg.lessonIds[i]}@kingston-tutoring`);
      expect(ics).toContain(`DTSTART:${icsUtc(s)}`);
      expect(ics).toContain(`DTEND:${icsUtc(s + 3600)}`);
    }
    expect(ics.match(/SEQUENCE:0/g)).toHaveLength(4);
    expect(ics).toContain(`URL:https://public.test/booking/${bookingId}`);
    expect(ics).not.toMatch(/\/b\/[A-Za-z0-9_-]{43}/); // never embeds the bearer token
    // A second download is identical apart from DTSTAMP (stable UIDs).
    const again = await (await student.get(`/booking/${bookingId}/calendar.ics`)).text();
    expect(again.replace(/DTSTAMP:\w+/g, '')).toBe(ics.replace(/DTSTAMP:\w+/g, ''));
  });
});
