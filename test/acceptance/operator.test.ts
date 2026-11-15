/**
 * Operator rehearsal (build plan §8.3): publication rules, clashes, offline registration, waitlist,
 * pausing, cancellation and link requests, wording versions, aggregate stats and rate limits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdminClient, type TestApp, startApp } from '../helpers/app';
import {
  DAY,
  book,
  bookAndPay,
  bookingIdForEmail,
  bookingRow,
  checkoutSessionId,
  dateKey,
  extract,
  flash,
  nowSec,
  openForm,
  pageText,
  seedConfirmed,
  seedListing,
} from '../helpers/flows';

const inDays = (n: number) => dateKey(new Date(Date.now() + n * DAY * 1000));

describe('operator workflow', () => {
  let app: TestApp;
  let admin: AdminClient;
  beforeAll(async () => {
    app = await startApp();
    admin = app.admin();
  });
  afterAll(async () => app?.close());

  it('requires real enrolment details before publishing and blocks clashing groups', async () => {
    const created = await admin.act('/listings', { title: 'Pilot class', topic: 'Python test questions', slug: 'pilot-class', kind: 'single', price: '15', capacity: '8', cutoff_minutes: '120' });
    const id = extract(created.headers.get('Location')!, /\/listings\/(lst_[a-z0-9]+)/);
    expect(flash(await admin.act(`/listings/${id}/publish`))).toContain('Add at least one date');
    await admin.act(`/listings/${id}/lessons`, { date: inDays(20), time: '18:00', duration: '60', meeting_url: '' });
    expect(flash(await admin.act(`/listings/${id}/publish`))).toContain('has no call link');
    const lesson = await app.db.prepare('SELECT id FROM lessons WHERE listing_id = ?').bind(id).first<{ id: string }>();
    await admin.act(`/listings/${id}/lessons/${lesson!.id}`, { date: inDays(20), time: '18:00', duration: '60', meeting_url: 'https://meet.example.com/pilot' });
    expect(flash(await admin.act(`/listings/${id}/publish`))).toContain('Published');
    expect((await app.student().get('/session/pilot-class')).status).toBe(200);

    // A second group at an overlapping time cannot be published.
    const other = await admin.act('/listings', { title: 'Clashing group', topic: 'Python', slug: 'clashing', kind: 'single', price: '15', capacity: '8', cutoff_minutes: '120' });
    const otherId = extract(other.headers.get('Location')!, /\/listings\/(lst_[a-z0-9]+)/);
    const added = await admin.act(`/listings/${otherId}/lessons`, { date: inDays(20), time: '18:30', duration: '60', meeting_url: 'https://meet.example.com/clash' });
    expect(flash(added)).toContain('overlaps draft');
    const page = await pageText(await admin.get(`/listings/${otherId}`));
    expect(page).toContain('Clash:');
    expect(flash(await admin.act(`/listings/${otherId}/publish`))).toContain('Clash');
    const status = await app.db.prepare('SELECT status FROM listings WHERE id = ?').bind(otherId).first<{ status: string }>();
    expect(status!.status).toBe('draft');
  });

  it('records a separately paid student with an audit entry, using the same capacity check', async () => {
    const listing = await seedListing(app.db, { slug: 'offline-pay', capacity: 2, lessons: [{ start: nowSec() + 20 * DAY }] });
    const res = await admin.act(`/listings/${listing.id}/manual-booking`, { first_name: 'Cash', email: 'cash@example.com', payment_reference: 'Cash 14 Nov', amount: '15' });
    const html = await pageText(res);
    expect(html).toContain('Registered Cash');
    const link = extract(html, /(https:\/\/public\.test\/b\/[A-Za-z0-9_-]{43})/);
    const bookingId = await bookingIdForEmail(app.db, 'cash@example.com');
    expect(await bookingRow(app.db, bookingId)).toMatchObject({ status: 'confirmed', source: 'manual', payment_reference: 'Cash 14 Nov', amount_paid_pence: 1500 });
    const auditRow = await app.db.prepare(`SELECT actor FROM admin_actions WHERE action = 'manual_registration' AND entity_id = ?`).bind(bookingId).first<{ actor: string }>();
    expect(auditRow!.actor).toBe('tutor@example.com');
    // Their private link works.
    const student = app.student();
    expect((await student.follow(await student.get(link.replace('https://public.test', '')))).status).toBe(200);
    // Fill the last seat, then the next manual registration is refused.
    await seedConfirmed(app.db, listing.id, 1);
    const refused = await admin.act(`/listings/${listing.id}/manual-booking`, { first_name: 'Late', email: 'late-cash@example.com', payment_reference: 'x', amount: '15' });
    expect(flash(refused)).toContain('No seats left');
  });

  it('runs the waitlist: dedupe, separate opt-ins, leaving, and a BCC seat alert', async () => {
    const listing = await seedListing(app.db, { slug: 'wait-group', title: 'Wait group', capacity: 1, lessons: [{ start: nowSec() + 20 * DAY }] });
    await seedConfirmed(app.db, listing.id, 1);
    const student = app.student();
    const listingPage = await pageText(await student.get(`/session/${listing.slug}`));
    expect(listingPage).toContain('Sold out');
    expect(listingPage).toContain('Join the waitlist');
    const form = await pageText(await student.get(`/waitlist?l=${listing.slug}`));
    expect(form).toMatch(/name="seat_alert" value="1" checked/);
    expect(form).not.toMatch(/name="weekly" value="1" checked/); // promotional opt-in unchecked by default
    const join = { l: listing.slug, email: 'Wait@Example.com', first_name: 'Wen', days: ['Tue', 'Thu'], seat_alert: '1', 'cf-turnstile-response': 'pass' };
    const joined = await pageText(await student.post('/waitlist', join));
    expect(joined).toContain("You're on the list");
    const rejoined = await pageText(await student.post('/waitlist', { ...join, weekly: '1' })); // same person again
    const rows = await app.db.prepare('SELECT * FROM waitlist WHERE listing_key = ?').bind(listing.id).all<Record<string, any>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ email: 'wait@example.com', preferred_days: 'Tue,Thu', wants_seat_alert: 1, wants_weekly_question: 1 });
    // Seat alert email to the waitlist (BCC), then mark it sent.
    const alert = await pageText(await admin.act('/messages/prepare', { template: 'waitlist', listing: listing.id }));
    expect(alert).toContain('1 recipient(s): wait@example.com');
    expect(alert).toContain('https://public.test/session/wait-group?ref=waitlist');
    const ids = extract(alert, /name="waitlist_ids" value="([^"]+)"/);
    await admin.act('/messages/sent', { template: 'waitlist', listing: listing.id, recipients: '1', subject_sent: 'seat', waitlist_ids: ids });
    expect((await app.db.prepare('SELECT alert_sent_at FROM waitlist WHERE id = ?').bind(ids).first<{ alert_sent_at: number }>())!.alert_sent_at).toBeTruthy();
    // Leaving the list: re-joining issued a fresh leave link (the first one no longer works).
    const firstLeave = extract(joined, /(\/waitlist\/leave\/[A-Za-z0-9_-]{43})/);
    expect((await student.get(firstLeave)).status).toBe(404);
    const leaveLink = extract(rejoined, /(\/waitlist\/leave\/[A-Za-z0-9_-]{43})/);
    const confirmPage = await pageText(await student.get(leaveLink));
    expect(confirmPage).toContain('Leave the waitlist?');
    expect((await app.db.prepare('SELECT left_at FROM waitlist WHERE listing_key = ?').bind(listing.id).first<{ left_at: number | null }>())!.left_at).toBeNull(); // GET does not mutate
    expect(await pageText(await student.post(leaveLink, {}))).toContain("You've left the list");
    expect((await app.db.prepare('SELECT left_at FROM waitlist WHERE listing_key = ?').bind(listing.id).first<{ left_at: number }>())!.left_at).toBeTruthy();
    // "Get the next date" when nothing is published goes to the general list.
    const general = await pageText(await student.get('/waitlist'));
    expect(general).toContain('Get the next date');
  });

  it('pauses and resumes all new bookings', async () => {
    const listing = await seedListing(app.db, { slug: 'pause-group', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const form = await openForm(student, listing.slug);
    await admin.act('/pause', { paused: '1' });
    const page = await pageText(await app.student().get(`/session/${listing.slug}`));
    expect(page).toContain('Bookings paused');
    const res = await student.post(`/session/${listing.slug}/book`, { first_name: 'P', email: 'paused@example.com', terms: '1', early_request: '1', early_ack: '1', nonce: form.nonce, ref: 'direct', 'cf-turnstile-response': 'pass' });
    expect(res.status).toBe(409);
    expect(await app.db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE email = ?').bind('paused@example.com').first()).toEqual({ n: 0 });
    await admin.act('/pause', { paused: '0' });
    checkoutSessionId(await book(app.student(), listing.slug, { email: 'resumed@example.com' }));
  });

  it('routes cancellation and private-link requests to the dashboard', async () => {
    const listing = await seedListing(app.db, { slug: 'requests-group', title: 'Requests group', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const { bookingId } = await bookAndPay(app, student, listing.slug, 'requests@example.com', 'Rae');
    const page = await pageText(await student.get(`/booking/${bookingId}`));
    const t = extract(page, /action="\/booking\/[a-z0-9_]+\/cancel-request">\s*<input type="hidden" name="t" value="([a-f0-9]+)"/);
    const after = await pageText(await student.post(`/booking/${bookingId}/cancel-request`, { t, note: 'Exam clash' }));
    expect(after).toContain('Your cancellation request has been sent');
    expect(await pageText(await admin.get('/'))).toContain('Cancellation requests (1)');
    const detail = await pageText(await admin.get(`/bookings/${bookingId}`));
    expect(detail).toContain('Exam clash');
    // Second device without a link asks for it; the response never reveals whether a booking exists.
    const phone = app.student();
    const generic = await pageText(await phone.post('/booking/recover', { email: 'requests@example.com', 'cf-turnstile-response': 'pass' }));
    const unknown = await pageText(await app.student().post('/booking/recover', { email: 'nobody@example.com', 'cf-turnstile-response': 'pass' }));
    expect(generic).toContain("If there's a booking for that email");
    expect(unknown).toContain("If there's a booking for that email");
    const dash = await pageText(await admin.get('/'));
    expect(dash).toContain('Private link requests (2)');
    const reqId = (await app.db.prepare('SELECT id FROM link_requests WHERE email = ?').bind('requests@example.com').first<{ id: string }>())!.id;
    const issued = await pageText(await admin.act(`/link-requests/${reqId}/issue`, { booking: bookingId }));
    const link = extract(issued, /(https:\/\/public\.test\/b\/[A-Za-z0-9_-]{43})/);
    expect((await phone.follow(await phone.get(link.replace('https://public.test', '')))).status).toBe(200);
    expect(await pageText(await phone.get(`/booking/${bookingId}`))).toContain('Rae');
    // Revoking links locks out both the link and devices that used it.
    await admin.act(`/bookings/${bookingId}/revoke-links`);
    expect((await phone.get(`/booking/${bookingId}`)).status).toBe(404);
  });

  it('versions the terms when the wording changes and records the version on new bookings', async () => {
    const listing = await seedListing(app.db, { slug: 'terms-group', lessons: [{ start: nowSec() + 20 * DAY }] });
    const before = (await pageText(await app.student().get('/terms'))).match(/Version ([0-9.-]+)/)![1]!;
    await admin.act('/settings', { cancellation_summary: 'Updated cancellation wording for review.', seller_name: 'Test Seller', seller_address: '1 Test Street, Kingston upon Thames', seller_email: 'seller@example.com' });
    const terms = await pageText(await app.student().get('/terms'));
    const after = terms.match(/Version ([0-9.-]+)/)![1]!;
    expect(after).not.toBe(before);
    expect(terms).toContain('Updated cancellation wording for review.');
    expect(terms).toContain('Sold by <strong>Test Seller</strong>, 1 Test Street, Kingston upon Thames');
    const archived = await app.db.prepare(`SELECT COUNT(*) AS n FROM policy_versions WHERE kind = 'terms' AND version = ?`).bind(after).first<{ n: number }>();
    expect(archived!.n).toBe(1);
    const res = await book(app.student(), listing.slug, { email: 'terms@example.com' });
    checkoutSessionId(res);
    const row = await bookingRow(app.db, await bookingIdForEmail(app.db, 'terms@example.com'));
    expect(row.terms_version).toBe(after);
  });

  it('shows aggregate outreach counts without personal data', async () => {
    await app.student().get('/?ref=qr-library');
    await app.student().get('/?ref=qr-library');
    const stats = await pageText(await admin.get('/stats'));
    expect(stats).toContain('qr-library');
    const row = await app.db.prepare(`SELECT SUM(count) AS n FROM daily_counts WHERE code = 'qr-library' AND metric = 'visit'`).first<{ n: number }>();
    expect(row!.n).toBe(2);
    const columns = await app.db.prepare('PRAGMA table_info(daily_counts)').all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toEqual(['day', 'metric', 'code', 'count']);
  });

  it('rate-limits booking attempts per client', async () => {
    const listing = await seedListing(app.db, { slug: 'rate-limit', lessons: [{ start: nowSec() + 20 * DAY }] });
    const student = app.student();
    const form = await openForm(student, listing.slug);
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await student.post(`/session/${listing.slug}/book`, { first_name: '', email: 'bad', nonce: form.nonce, ref: 'direct' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 12).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(12)).toEqual([429, 429]);
    const key = await app.db.prepare(`SELECT key FROM rate_limits WHERE key LIKE 'book:%' LIMIT 1`).first<{ key: string }>();
    expect(key!.key).not.toContain(student.ip); // IPs are stored only as HMACs
  });
});

describe('production publishing rules', () => {
  it('blocks placeholder call links and missing seller details in production', async () => {
    const app = await startApp({ adminEnv: { ENVIRONMENT: 'production' } });
    try {
      const admin = app.admin();
      const created = await admin.act('/listings', { title: 'Real class', topic: 'Python', slug: 'real-class', kind: 'single', price: '15', capacity: '8', cutoff_minutes: '120' });
      const id = extract(created.headers.get('Location')!, /\/listings\/(lst_[a-z0-9]+)/);
      await admin.act(`/listings/${id}/lessons`, { date: inDays(20), time: '18:00', duration: '60', meeting_url: 'https://meet.example.com/abc-defg-hij' });
      const blocked = flash(await admin.act(`/listings/${id}/publish`));
      expect(blocked).toContain('placeholder call link');
      expect(blocked).toContain('Seller name, address and contact email are not set');
      const lesson = await app.db.prepare('SELECT id FROM lessons WHERE listing_id = ?').bind(id).first<{ id: string }>();
      await admin.act(`/listings/${id}/lessons/${lesson!.id}`, { date: inDays(20), time: '18:00', duration: '60', meeting_url: 'https://meet.google.com/abc-defg-hij' });
      await admin.act('/settings', { seller_name: 'A Seller', seller_address: '1 Real Road, Kingston upon Thames KT1 1AA', seller_email: 'hello@seller.co.uk' });
      expect(flash(await admin.act(`/listings/${id}/publish`))).toContain('Published');
    } finally {
      await app.close();
    }
  });
});
