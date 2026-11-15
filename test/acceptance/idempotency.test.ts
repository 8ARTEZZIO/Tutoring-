/**
 * Acceptance: "Double-click, webhook retries and late payment return → exactly one paid booking, with the
 * right capacity and price."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import {
  DAY,
  book,
  bookingFields,
  bookingIdForEmail,
  bookingRow,
  checkoutSessionId,
  metric,
  nowSec,
  occupied,
  openForm,
  pageText,
  seedListing,
} from '../helpers/flows';

describe('idempotent booking and fulfilment', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app?.close());

  it('a double-clicked submit produces one booking and one Checkout Session', async () => {
    const listing = await seedListing(app.db, { slug: 'double-click', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const form = await openForm(student, listing.slug);
    const fields = bookingFields(form, { email: 'double@example.com' });
    const [first, second] = await Promise.all([
      student.post(`/session/${listing.slug}/book`, fields),
      student.post(`/session/${listing.slug}/book`, fields),
    ]);
    // Whatever each click got back, following it leads to the same Checkout Session.
    const resolve = async (r: Response) => {
      let res = r;
      for (let i = 0; i < 5 && res.status === 202; i++) {
        const next = /url=([^"]+)"/.exec(await res.text())![1]!.replace(/&amp;/g, '&');
        res = await student.get(next);
      }
      return checkoutSessionId(res);
    };
    const [s1, s2] = await Promise.all([resolve(first), resolve(second)]);
    expect(s1).toBe(s2);
    const rows = await app.db.prepare('SELECT id FROM bookings WHERE email = ?').bind('double@example.com').all();
    expect(rows.results).toHaveLength(1);
    expect([...app.stripe.sessions.values()].filter((s) => s.customer_email === 'double@example.com')).toHaveLength(1);
    const keys = new Set(app.stripe.requests.filter((r) => r.path === '/v1/checkout/sessions' && r.body.includes('double%40example.com')).map((r) => r.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(await occupied(app.db, listing.id)).toBe(1);
  });

  it('webhook retries and duplicate event types confirm exactly once', async () => {
    const listing = await seedListing(app.db, { slug: 'webhook-retries', price: 1500, lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const res = await book(student, listing.slug, { email: 'retry@example.com' });
    const sessionId = checkoutSessionId(res);
    const bookingId = await bookingIdForEmail(app.db, 'retry@example.com');
    const paidBefore = await metric(app.db, 'paid');
    app.stripe.pay(sessionId);
    const event = app.stripe.sessionEvent('checkout.session.completed', sessionId);
    const deliveries = await Promise.all([app.webhook(event), app.webhook(event), app.webhook(event)]);
    expect(deliveries.map((d) => d.status)).toEqual([200, 200, 200]);
    const again = await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId)); // new event id, same session
    const async = await app.webhook(app.stripe.sessionEvent('checkout.session.async_payment_succeeded', sessionId));
    expect(again.status).toBe(200);
    expect(async.status).toBe(200);
    const row = await bookingRow(app.db, bookingId);
    expect(row.status).toBe('confirmed');
    expect(row.amount_paid_pence).toBe(1500);
    expect(await metric(app.db, 'paid')).toBe(paidBefore + 1);
    const confirmations = await app.db
      .prepare(`SELECT COUNT(*) AS n FROM admin_actions WHERE action = 'payment_confirmed' AND entity_id = ?`)
      .bind(bookingId)
      .first<{ n: number }>();
    expect(confirmations!.n).toBe(1);
    const ev = await app.db.prepare('SELECT attempts, processed_at FROM stripe_events WHERE id = ?').bind(event.id).first<{ attempts: number; processed_at: number }>();
    expect(ev!.attempts).toBe(3);
    expect(ev!.processed_at).toBeTruthy();
    expect(await occupied(app.db, listing.id)).toBe(1);
  });

  it('a browser return before the webhook confirms via server-side reconciliation; the late webhook is a no-op', async () => {
    const listing = await seedListing(app.db, { slug: 'return-first', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const sessionId = checkoutSessionId(await book(student, listing.slug, { email: 'early-return@example.com' }));
    const bookingId = await bookingIdForEmail(app.db, 'early-return@example.com');
    // Before payment, the return URL shows a pending state rather than a confirmation.
    const pending = await student.get(`/checkout/return?b=${bookingId}&session_id=${sessionId}`);
    expect(pending.status).toBe(202);
    expect(await pageText(pending)).toContain('Payment pending');
    app.stripe.pay(sessionId);
    const ret = await student.get(`/checkout/return?b=${bookingId}&session_id=${sessionId}`);
    expect(ret.status).toBe(303);
    expect(ret.headers.get('Location')).toBe(`/booking/${bookingId}?welcome=1`);
    expect((await bookingRow(app.db, bookingId)).status).toBe('confirmed');
    const paid = await metric(app.db, 'paid');
    const hook = await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
    expect(hook.status).toBe(200);
    expect(await hook.json()).toMatchObject({ outcome: 'confirmed' });
    expect(await metric(app.db, 'paid')).toBe(paid);
  });

  it('a late browser return after the webhook shows the confirmation without double counting', async () => {
    const listing = await seedListing(app.db, { slug: 'late-return', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const sessionId = checkoutSessionId(await book(student, listing.slug, { email: 'late@example.com', firstName: 'Lee' }));
    const bookingId = await bookingIdForEmail(app.db, 'late@example.com');
    app.stripe.pay(sessionId);
    await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
    const paid = await metric(app.db, 'paid');
    const page = await pageText(await student.follow(await student.get(`/checkout/return?b=${bookingId}&session_id=${sessionId}`)));
    expect(page).toContain("You're booked!");
    expect(page).toContain('Lee');
    expect(await metric(app.db, 'paid')).toBe(paid);
  });

  it('snapshots the price at reservation; a later price change only affects new bookings', async () => {
    const listing = await seedListing(app.db, { slug: 'price-snapshot', price: 8000, lessons: [0, 7, 14, 21].map((d) => ({ start: nowSec() + (20 + d) * DAY })) });
    const a = app.student();
    const sessionA = checkoutSessionId(await book(a, listing.slug, { email: 'snapshot-a@example.com' }));
    await app.db.prepare('UPDATE listings SET price_pence = 10800 WHERE id = ?').bind(listing.id).run();
    const b = app.student();
    const sessionB = checkoutSessionId(await book(b, listing.slug, { email: 'snapshot-b@example.com' }));
    expect(app.stripe.sessions.get(sessionA)!.amount_total).toBe(8000);
    expect(app.stripe.sessions.get(sessionB)!.amount_total).toBe(10800);
    app.stripe.pay(sessionA);
    await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionA));
    const rowA = await bookingRow(app.db, await bookingIdForEmail(app.db, 'snapshot-a@example.com'));
    expect(rowA).toMatchObject({ status: 'confirmed', price_pence: 8000, amount_paid_pence: 8000 });
    const page = await pageText(await a.get(`/booking/${rowA.id}`));
    expect(page).toContain('£80 total for all 4 sessions');
  });
});
