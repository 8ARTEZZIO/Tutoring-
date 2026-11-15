/**
 * Acceptance: "General visit, invite, expired invite and already paid → the right group or fallback is
 * shown. Private data stays private."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import { DAY, book, bookAndPay, bookingRow, checkoutSessionId, extract, metric, nowSec, seedConfirmed, seedListing } from '../helpers/flows';

describe('entry routes', () => {
  let app: TestApp;
  let pilot: { id: string; slug: string };
  let pkg: { id: string; slug: string };
  let full: { id: string; slug: string };

  beforeAll(async () => {
    app = await startApp();
    const t = nowSec();
    pilot = await seedListing(app.db, { slug: 'pilot-loops', title: 'Python pilot: loops', price: 1500, lessons: [{ start: t + 20 * DAY }] });
    pkg = await seedListing(app.db, {
      slug: 'four-week-group',
      title: 'Four-week group',
      price: 8000,
      lessons: [0, 7, 14, 21].map((d) => ({ start: t + (25 + d) * DAY })),
    });
    full = await seedListing(app.db, { slug: 'full-group', title: 'Full group', capacity: 1, lessons: [{ start: t + 22 * DAY }] });
    await seedConfirmed(app.db, full.id, 1);
    await seedListing(app.db, { slug: 'secret-draft', title: 'Secret draft', status: 'draft', lessons: [{ start: t + 21 * DAY }] });
  });
  afterAll(async () => app?.close());

  it('general visit shows the next bookable group with price, UK times, capacity and the primary CTA', async () => {
    const res = await app.student().get('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Get unstuck on Python test questions.');
    expect(html).toContain('Python pilot: loops');
    expect(html).toContain('Book a seat · £15');
    expect(html).toContain('UK time (GMT)');
    expect(html).toContain('Up to 8 students');
    expect(html).toContain('8 of 8 seats left');
    expect(html).toContain('Independent peer tutoring');
    expect(html).not.toContain('Secret draft');
    expect(html).not.toContain('meet.example.com'); // meeting links are private
    expect(await metric(app.db, 'visit', 'direct')).toBeGreaterThanOrEqual(1);
  });

  it('a channel share link records the visit, sets attribution and opens its group', async () => {
    const admin = app.admin();
    const created = await admin.act(`/listings/${pkg.id}/share-links`, { channel: 'whatsapp', code: 'wa-cs-society' });
    expect(created.status).toBe(303);
    const student = app.student();
    const res = await student.get('/i/wa-cs-society');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?g=four-week-group');
    expect([...student.cookies.keys()].some((k) => k.endsWith('kt_ref'))).toBe(true);
    const page = await (await student.follow(res)).text();
    expect(page).toContain('Four-week group');
    expect(page).toContain('Your invitation');
    expect(page).toContain('Book a seat · £80');
    expect(await metric(app.db, 'visit', 'wa-cs-society')).toBe(1);
    // A checkout started from here is attributed to the code.
    const booked = await book(student, pkg.slug, { email: 'share@example.com' });
    checkoutSessionId(booked);
    expect(await metric(app.db, 'checkout_start', 'wa-cs-society')).toBe(1);
  });

  it('an individual invite opens its group without leaving the token in the URL, and tracks status', async () => {
    const admin = app.admin();
    const res = await admin.act(`/listings/${pilot.id}/invites`, { note: 'referred by study group', days: '7' });
    const html = await res.text();
    const url = extract(html, /value="(https:\/\/public\.test\/i\/[A-Za-z0-9_-]{43})"/);
    const token = url.split('/i/')[1]!;
    const student = app.student();
    const open = await student.get(`/i/${token}`);
    expect(open.status).toBe(303);
    expect(open.headers.get('Location')).toBe('/?g=pilot-loops');
    expect(open.headers.get('Location')).not.toContain(token);
    expect(open.headers.get('Cache-Control')).toContain('no-store');
    const page = await (await student.follow(open)).text();
    expect(page).toContain('Your invitation');
    expect(page).toContain('Python pilot: loops');
    const stored = await app.db.prepare(`SELECT * FROM invites WHERE kind = 'individual'`).first<Record<string, any>>();
    expect(stored!.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token); // only the hash is stored
    expect(stored!.first_opened_at).toBeTruthy();
    let listing = await (await admin.get(`/listings/${pilot.id}`)).text();
    expect(listing).toContain('Opened · not paid');
    // Unpaid assignment → checkout; the dashboard shows the progress.
    const booked = await book(student, pilot.slug, { email: 'invited@example.com' });
    checkoutSessionId(booked);
    const row = await app.db.prepare('SELECT source, invite_id FROM bookings WHERE email = ?').bind('invited@example.com').first<Record<string, any>>();
    expect(row).toMatchObject({ source: 'invite', invite_id: stored!.id });
    listing = await (await admin.get(`/listings/${pilot.id}`)).text();
    expect(listing).toContain('Checkout started');
  });

  it('an expired invite explains its state and falls back to the group as it stands', async () => {
    const admin = app.admin();
    const html = await (await admin.act(`/listings/${pkg.id}/invites`, { days: '3' })).text();
    const token = extract(html, /\/i\/([A-Za-z0-9_-]{43})"/);
    await app.db.prepare(`UPDATE invites SET expires_at = ? WHERE kind = 'individual' AND first_opened_at IS NULL`).bind(nowSec() - 60).run();
    const student = app.student();
    const res = await student.get(`/i/${token}`);
    const page = await res.text();
    expect(res.status).toBe(410);
    expect(page).toContain('This invitation has expired');
    expect(page).toContain('Four-week group');
    expect(page).not.toContain('Your invitation');
    expect([...student.cookies.keys()].some((k) => k.endsWith('kt_ref'))).toBe(false);
  });

  it('revoked and invalid invites fall back to the next bookable group', async () => {
    const admin = app.admin();
    await admin.act(`/listings/${pkg.id}/share-links`, { channel: 'poster', code: 'poster-library' });
    const inv = await app.db.prepare(`SELECT id FROM invites WHERE code = 'poster-library'`).first<{ id: string }>();
    await admin.act(`/invites/${inv!.id}/revoke`);
    const revoked = await app.student().get('/i/poster-library');
    expect(revoked.status).toBe(410);
    expect(await revoked.text()).toContain('withdrawn');
    const invalid = await app.student().get('/i/not-a-real-code');
    const text = await invalid.text();
    expect(invalid.status).toBe(404);
    expect(text).toContain("isn't valid");
    expect(text).toContain('Book a seat');
  });

  it('an invite to a full group shows that it is full with a waitlist and another date', async () => {
    const admin = app.admin();
    await admin.act(`/listings/${full.id}/share-links`, { channel: 'friend', code: 'friend-full' });
    const student = app.student();
    const page = await (await student.follow(await student.get('/i/friend-full'))).text();
    expect(page).toContain('Full group');
    expect(page).toContain('This group is full.');
    expect(page).toContain('Join the waitlist');
    expect(page).toContain('Another date is open');
  });

  it('an already-paid student opens a private page via their link; the token is exchanged for a cookie', async () => {
    const { bookingId } = await bookAndPay(app, app.student(), pilot.slug, 'paid@example.com', 'Priya');
    // Operator sends the confirmation email with a fresh private link.
    const admin = app.admin();
    const prepared = await (await admin.act('/messages/prepare', { template: 'confirmation', booking: bookingId })).text();
    const link = extract(prepared, /(https:\/\/public\.test\/b\/[A-Za-z0-9_-]{43})/);
    expect(prepared).toContain('Python pilot: loops');
    expect(prepared).toContain('£15');

    const otherDevice = app.student();
    const exchange = await otherDevice.get(link.replace('https://public.test', ''));
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get('Location')).toBe(`/booking/${bookingId}`);
    expect(exchange.headers.get('Referrer-Policy')).toBe('no-referrer');
    const setCookie = exchange.headers.getSetCookie().join(';');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    const page = await otherDevice.get(`/booking/${bookingId}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Confirmed');
    expect(html).toContain('Priya');
    expect(html).toContain('https://meet.example.com/pilot-loops-1');
    expect(page.headers.get('Cache-Control')).toContain('no-store');
    expect(page.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(page.headers.get('Referrer-Policy')).toBe('same-origin');
    const ics = await otherDevice.get(`/booking/${bookingId}/calendar.ics`);
    expect(ics.status).toBe(200);
    expect(ics.headers.get('Cache-Control')).toContain('no-store');
  });

  it('keeps private data private: no cookie, wrong booking, bad link, public pages', async () => {
    const { bookingId } = await bookAndPay(app, app.student(), pkg.slug, 'private@example.com', 'Quinn');
    const stranger = app.student();
    for (const path of [`/booking/${bookingId}`, `/booking/${bookingId}/calendar.ics`]) {
      const res = await stranger.get(path);
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(text).not.toContain('Quinn');
      expect(text).not.toContain('meet.example.com');
    }
    // A different booking's cookie does not unlock this one.
    const other = app.student();
    await bookAndPay(app, other, pilot.slug, 'other@example.com', 'Olu');
    expect((await other.get(`/booking/${bookingId}`)).status).toBe(404);
    expect((await stranger.get('/b/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    for (const path of ['/', '/calendar', `/session/${pkg.slug}`, `/session/${pilot.slug}`, '/robots.txt']) {
      const text = await (await stranger.get(path)).text();
      expect(text).not.toContain('meet.example.com');
      expect(text).not.toContain('private@example.com');
      expect(text).not.toContain('Quinn');
    }
    expect((await stranger.get('/session/secret-draft')).status).toBe(404);
    // Booking rows store hashes of access tokens only.
    const tokens = await app.db.prepare('SELECT token_hash FROM access_tokens WHERE booking_id = ?').bind(bookingId).all<{ token_hash: string }>();
    expect(tokens.results.every((t) => /^[a-f0-9]{64}$/.test(t.token_hash))).toBe(true);
    expect((await bookingRow(app.db, bookingId)).status).toBe('confirmed');
  });
});
