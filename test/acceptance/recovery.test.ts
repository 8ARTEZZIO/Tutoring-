/**
 * Acceptance: "Lost Stripe response, expired checkout, full and partial refund, cancelled group → state
 * recovers or is visible to the operator. Inventory reflects verified payment state."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import {
  DAY,
  book,
  bookAndPay,
  bookingIdForEmail,
  bookingRow,
  checkoutSessionId,
  nowSec,
  occupied,
  flash,
  pageText,
  seedListing,
} from '../helpers/flows';

describe('recovery and operator visibility', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app?.close());

  it('lost Checkout response: the seat stays held, the operator sees it, and a retry recovers the same session', async () => {
    const listing = await seedListing(app.db, { slug: 'lost-response', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    app.stripe.createFaults.push({ kind: 'drop' });
    const student = app.student();
    const res = await book(student, listing.slug, { email: 'lost@example.com' });
    expect(res.status).toBe(202);
    expect(await pageText(res)).toContain('Getting your secure checkout ready');
    const bookingId = await bookingIdForEmail(app.db, 'lost@example.com');
    const row = await bookingRow(app.db, bookingId);
    expect(row.status).toBe('hold');
    expect(row.issue).toContain('outcome unknown');
    expect(row.checkout_request).toBeTruthy(); // persisted before sending
    expect(app.stripe.sessions.size).toBeGreaterThan(0);
    const created = app.stripe.sessionFor(bookingId)!; // Stripe did create it; we just never heard back
    expect(await occupied(app.db, listing.id)).toBe(1); // still occupies capacity
    expect(await pageText(await app.student().get(`/session/${listing.slug}`))).toContain('Full right now');
    const dash = await pageText(await app.admin().get('/'));
    expect(dash).toContain('Checkout creation outcome unknown');

    const resumed = await student.get(`/checkout/resume?b=${bookingId}`);
    expect(resumed.status).toBe(303);
    expect(checkoutSessionId(resumed)).toBe(created.id); // exact replay → the same session, no duplicate
    expect([...app.stripe.sessions.values()].filter((s) => s.client_reference_id === bookingId)).toHaveLength(1);
    const after = await bookingRow(app.db, bookingId);
    expect(after).toMatchObject({ status: 'pending', checkout_session_id: created.id, issue: null });
  });

  it('lost response recovered by the scheduled reconciliation without the student returning', async () => {
    const listing = await seedListing(app.db, { slug: 'lost-cron', lessons: [{ start: nowSec() + 20 * DAY }] });
    app.stripe.createFaults.push({ kind: 'drop' });
    await book(app.student(), listing.slug, { email: 'lost-cron@example.com' });
    const bookingId = await bookingIdForEmail(app.db, 'lost-cron@example.com');
    await app.db.prepare('UPDATE bookings SET updated_at = updated_at - 120 WHERE id = ?').bind(bookingId).run();
    await app.cron();
    const row = await bookingRow(app.db, bookingId);
    expect(row.status).toBe('pending');
    expect(row.checkout_session_id).toBe(app.stripe.sessionFor(bookingId)!.id);
  });

  it('a definite Stripe rejection releases the hold immediately', async () => {
    const listing = await seedListing(app.db, { slug: 'definite-fail', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    app.stripe.createFaults.push({ kind: 'status', status: 400, message: 'Invalid currency' });
    const res = await book(app.student(), listing.slug, { email: 'rejected@example.com' });
    expect(res.status).toBe(502);
    expect(await pageText(res)).toContain('Nothing has been charged and the seat has been released');
    expect((await bookingRow(app.db, await bookingIdForEmail(app.db, 'rejected@example.com'))).status).toBe('failed');
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('a persistent Stripe 500 keeps the seat held and visible until Stripe proves nothing can be paid', async () => {
    const listing = await seedListing(app.db, { slug: 'stripe-500', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    app.stripe.createFaults.push({ kind: 'status', status: 500 });
    const student = app.student();
    const res = await book(student, listing.slug, { email: 'five-hundred@example.com' });
    expect(res.status).toBe(202);
    const bookingId = await bookingIdForEmail(app.db, 'five-hundred@example.com');
    // Replays return Stripe's saved 500: still uncertain, still held, visible to the operator.
    const recheck = await app.admin().act(`/bookings/${bookingId}/recheck`);
    expect(flash(recheck)).toContain('uncertain');
    expect((await bookingRow(app.db, bookingId)).status).toBe('hold');
    expect(await occupied(app.db, listing.id)).toBe(1);
    expect(await pageText(await app.admin().get('/issues'))).toContain('Group stripe-500');
    // A day later the idempotency window has passed: look the session up instead. None exists and the
    // fixed expiry is long gone, so the seat can be released safely.
    await app.db
      .prepare('UPDATE bookings SET checkout_requested_at = checkout_requested_at - 90000, checkout_expires_at = checkout_expires_at - 90000, created_at = created_at - 90000, updated_at = updated_at - 90000 WHERE id = ?')
      .bind(bookingId)
      .run();
    await app.cron();
    expect((await bookingRow(app.db, bookingId)).status).toBe('failed');
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('an expired checkout releases the seat (webhook path)', async () => {
    const listing = await seedListing(app.db, { slug: 'expired-webhook', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    const sessionId = checkoutSessionId(await book(app.student(), listing.slug, { email: 'expired@example.com' }));
    expect(await occupied(app.db, listing.id)).toBe(1);
    // An "expired" event while Stripe still says open must not release anything.
    const premature = await app.webhook(app.stripe.event('checkout.session.expired', { ...app.stripe.sessions.get(sessionId)!, status: 'expired' }));
    expect(premature.status).toBe(200);
    expect(await occupied(app.db, listing.id)).toBe(1);
    app.stripe.expire(sessionId);
    await app.webhook(app.stripe.sessionEvent('checkout.session.expired', sessionId));
    expect((await bookingRow(app.db, await bookingIdForEmail(app.db, 'expired@example.com'))).status).toBe('expired');
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('an expired checkout releases the seat even if the webhook never arrives (cron path)', async () => {
    const listing = await seedListing(app.db, { slug: 'expired-cron', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    const sessionId = checkoutSessionId(await book(app.student(), listing.slug, { email: 'expired-cron@example.com' }));
    const bookingId = await bookingIdForEmail(app.db, 'expired-cron@example.com');
    // Local expiry alone is not trusted: with Stripe still "open", nothing is released.
    await app.db.prepare('UPDATE bookings SET checkout_expires_at = ? WHERE id = ?').bind(nowSec() - 120, bookingId).run();
    await app.cron();
    expect((await bookingRow(app.db, bookingId)).status).toBe('pending');
    // The first reconcile re-read the real expiry from Stripe (local value corrected).
    expect((await bookingRow(app.db, bookingId)).checkout_expires_at).toBe(app.stripe.sessions.get(sessionId)!.expires_at);
    // Now let time really pass: Stripe's expires_at (and our copy of it) are in the past.
    app.stripe.age(sessionId, 45 * 60);
    await app.db.prepare('UPDATE bookings SET checkout_expires_at = ? WHERE id = ?').bind(app.stripe.sessions.get(sessionId)!.expires_at, bookingId).run();
    await app.cron();
    expect((await bookingRow(app.db, bookingId)).status).toBe('expired');
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('a full refund is verified with Stripe before the seat is released', async () => {
    const listing = await seedListing(app.db, { slug: 'full-refund', capacity: 2, lessons: [{ start: nowSec() + 20 * DAY }] });
    const { bookingId } = await bookAndPay(app, app.student(), listing.slug, 'full-refund@example.com');
    const pi = (await bookingRow(app.db, bookingId)).payment_intent_id as string;
    // Operator asks to release before any refund exists: refused.
    const early = await app.admin().act(`/bookings/${bookingId}/release-refunded`);
    expect(flash(early)).toContain('The seat stays booked');
    const refund = app.stripe.refund(pi, 1500);
    const hook = await app.webhook(app.stripe.event('charge.refunded', { id: 'ch_x', object: 'charge', payment_intent: pi, amount_refunded: refund.amount }));
    expect(await hook.json()).toMatchObject({ outcome: 'refund_full' });
    let row = await bookingRow(app.db, bookingId);
    expect(row).toMatchObject({ status: 'confirmed', refund_state: 'full', refunded_pence: 1500 });
    expect(row.issue).toContain('Fully refunded');
    expect(await occupied(app.db, listing.id)).toBe(1); // refund alone does not release the seat
    const detail = await pageText(await app.admin().get(`/bookings/${bookingId}`));
    expect(detail).toContain(refund.id as string);
    const release = await app.admin().act(`/bookings/${bookingId}/release-refunded`);
    expect(flash(release)).toContain('Verified full refund');
    row = await bookingRow(app.db, bookingId);
    expect(row).toMatchObject({ status: 'cancelled', cancel_reason: 'Fully refunded' });
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('a partial refund keeps the seat; cancelling the seat is a separate operator action', async () => {
    const listing = await seedListing(app.db, { slug: 'partial-refund', price: 8000, lessons: [0, 7, 14, 21].map((d) => ({ start: nowSec() + (20 + d) * DAY })) });
    const { bookingId } = await bookAndPay(app, app.student(), listing.slug, 'partial@example.com');
    const pi = (await bookingRow(app.db, bookingId)).payment_intent_id as string;
    app.stripe.refund(pi, 2000);
    const hook = await app.webhook(app.stripe.event('refund.created', { id: 're_x', object: 'refund', payment_intent: pi, amount: 2000 }));
    expect(await hook.json()).toMatchObject({ outcome: 'refund_partial' });
    expect(await bookingRow(app.db, bookingId)).toMatchObject({ status: 'confirmed', refund_state: 'partial', refunded_pence: 2000 });
    const release = await app.admin().act(`/bookings/${bookingId}/release-refunded`);
    expect(flash(release)).toContain('The seat stays booked');
    expect(await occupied(app.db, listing.id)).toBe(1);
    await app.admin().act(`/bookings/${bookingId}/cancel-seat`, { reason: 'Student withdrew after session 1' });
    expect(await bookingRow(app.db, bookingId)).toMatchObject({ status: 'cancelled', refund_state: 'partial' });
    expect(await occupied(app.db, listing.id)).toBe(0);
  });

  it('cancelling a group stops checkouts, expires open sessions, reconciles in-flight payments and lists actions', async () => {
    const listing = await seedListing(app.db, { slug: 'to-cancel', capacity: 8, lessons: [{ start: nowSec() + 20 * DAY }] });
    const paid = await bookAndPay(app, app.student(), listing.slug, 'cancel-paid@example.com', 'Paid');
    const openStudent = app.student();
    const openSession = checkoutSessionId(await book(openStudent, listing.slug, { email: 'cancel-open@example.com' }));
    const inflight = app.student();
    const inflightSession = checkoutSessionId(await book(inflight, listing.slug, { email: 'cancel-inflight@example.com' }));
    app.stripe.pay(inflightSession); // paid at Stripe, webhook not delivered yet
    const late = app.student();
    const lateForm = await (await late.get(`/session/${listing.slug}/book`)).text();

    const res = await app.admin().act(`/listings/${listing.id}/cancel`, { reason: 'Tutor unavailable' });
    expect(flash(res)).toContain('1 unpaid checkout(s) closed; 2 paid student(s) need a refund');

    // New checkouts stop immediately, even from a form loaded before the cancellation.
    const nonce = /name="nonce" value="([^"]+)"/.exec(lateForm)![1]!;
    const attempt = await late.post(`/session/${listing.slug}/book`, { first_name: 'Late', email: 'late-cancel@example.com', terms: '1', early_request: '1', early_ack: '1', nonce, ref: 'direct', 'cf-turnstile-response': 'pass' });
    expect(attempt.status).toBe(409);
    expect(await pageText(attempt)).toContain('This group has been cancelled');
    expect(app.stripe.sessions.get(openSession)!.status).toBe('expired');
    expect((await bookingRow(app.db, await bookingIdForEmail(app.db, 'cancel-open@example.com'))).status).toBe('cancelled');
    expect((await bookingRow(app.db, await bookingIdForEmail(app.db, 'cancel-inflight@example.com'))).status).toBe('confirmed');
    expect(await occupied(app.db, listing.id)).toBe(2);

    const page = await pageText(await app.admin().get(`/listings/${listing.id}`));
    expect(page).toContain('outstanding actions');
    expect(page).toContain('2</strong> paid booking(s) still need a refund');
    expect(page).toContain('cancel-inflight@example.com');
    expect(page).toContain('Prepare cancellation email');
    const email = await pageText(await app.admin().act('/messages/prepare', { template: 'cancelled', listing: listing.id }));
    expect(email).toContain('2 recipient(s)');
    expect(email).toContain('Tutor unavailable');

    // Students see the cancellation; their calendar file marks the event cancelled with a new SEQUENCE.
    const studentPage = await pageText(await app.student().get(`/session/${listing.slug}`));
    expect(studentPage).toContain('This group has been cancelled');
    const ics = await (await inflight.get(`/booking/${await bookingIdForEmail(app.db, 'cancel-inflight@example.com')}/calendar.ics`)).text();
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:1');
    expect(paid.bookingId).toBeTruthy();
  });
});
