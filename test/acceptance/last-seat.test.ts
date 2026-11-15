/**
 * Acceptance: "Simultaneous requests for the last seat → at most one payable checkout. The other student
 * sees an available recovery path."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import { DAY, bookingFields, checkoutSessionId, nowSec, occupied, openForm, seedConfirmed, seedListing } from '../helpers/flows';

describe('last seat under concurrency', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => app?.close());

  it('lets exactly one of five simultaneous students check out for the last seat', async () => {
    const listing = await seedListing(app.db, { slug: 'last-seat', capacity: 8, lessons: [{ start: nowSec() + 20 * DAY }] });
    await seedConfirmed(app.db, listing.id, 7);
    const students = Array.from({ length: 5 }, () => app.student());
    const forms = await Promise.all(students.map((s) => openForm(s, listing.slug)));
    const before = app.stripe.createCalls;
    const responses = await Promise.all(
      students.map((s, i) => s.post(`/session/${listing.slug}/book`, bookingFields(forms[i]!, { email: `race${i}@example.com` }))),
    );
    const winners = responses.filter((r) => r.status === 303 && (r.headers.get('Location') ?? '').includes('/c/pay/'));
    const losers = responses.filter((r) => !winners.includes(r));
    expect(winners).toHaveLength(1);
    expect(app.stripe.createCalls - before).toBe(1); // only one payable Checkout Session exists
    expect(await occupied(app.db, listing.id)).toBe(8);
    for (const r of losers) {
      expect(r.status).toBe(409);
      const html = await r.text();
      expect(html).toContain('Sorry, the last seat has just gone');
      expect(html).toContain('nothing has been charged');
      expect(html).toContain(`/waitlist?l=${listing.slug}`);
      expect(html).toContain('/calendar');
    }
    // The public page now shows the group as full with seats held in checkout.
    const page = await (await app.student().get(`/session/${listing.slug}`)).text();
    expect(page).toContain('Full right now');
    expect(page).toContain('Join the waitlist');

    // Recovery path: once the winner's checkout expires (verified with Stripe), a seat opens again.
    const winnerSession = checkoutSessionId(winners[0]!);
    app.stripe.expire(winnerSession);
    const hook = await app.webhook(app.stripe.sessionEvent('checkout.session.expired', winnerSession));
    expect(hook.status).toBe(200);
    expect(await occupied(app.db, listing.id)).toBe(7);
    const retry = students[losers.length > 0 ? responses.indexOf(losers[0]!) : 0]!;
    const form = await openForm(retry, listing.slug);
    const res = await retry.post(`/session/${listing.slug}/book`, bookingFields(form, { email: 'race-retry@example.com' }));
    expect(res.status).toBe(303);
    checkoutSessionId(res);
  });

  it('with a single-seat group, two simultaneous requests produce one checkout', async () => {
    const listing = await seedListing(app.db, { slug: 'one-seat', capacity: 1, lessons: [{ start: nowSec() + 21 * DAY }] });
    const a = app.student();
    const b = app.student();
    const [fa, fb] = await Promise.all([openForm(a, listing.slug), openForm(b, listing.slug)]);
    const [ra, rb] = await Promise.all([
      a.post(`/session/${listing.slug}/book`, bookingFields(fa, { email: 'one-a@example.com' })),
      b.post(`/session/${listing.slug}/book`, bookingFields(fb, { email: 'one-b@example.com' })),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([303, 409]);
    expect(await occupied(app.db, listing.id)).toBe(1);
  });
});
