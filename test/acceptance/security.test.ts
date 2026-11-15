/**
 * Acceptance: "Fake return URL, mismatched amount, invalid signature and unauthorised admin user → no
 * payment confirmation, private data or mutation."
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_AUD, TEAM_DOMAIN } from '../helpers/fake-access';
import { type TestApp, startApp } from '../helpers/app';
import {
  DAY,
  book,
  bookAndPay,
  bookingIdForEmail,
  bookingRow,
  checkoutSessionId,
  metric,
  nowSec,
  pageText,
  seedListing,
} from '../helpers/flows';

describe('security', () => {
  let app: TestApp;
  let listing: { id: string; slug: string };
  beforeAll(async () => {
    app = await startApp();
    listing = await seedListing(app.db, { slug: 'secure-group', title: 'Secure group', lessons: [{ start: nowSec() + 20 * DAY }] });
  });
  afterAll(async () => app?.close());

  it('a fake or tampered return URL never confirms a booking or reveals data', async () => {
    const student = app.student();
    const sessionId = checkoutSessionId(await book(student, listing.slug, { email: 'fake-return@example.com', firstName: 'Fay' }));
    const bookingId = await bookingIdForEmail(app.db, 'fake-return@example.com');
    // Same device, forged session id: verified against Stripe using the stored id → still pending.
    const forged = await student.get(`/checkout/return?b=${bookingId}&session_id=cs_test_forged`);
    expect(forged.status).toBe(202);
    expect(await pageText(forged)).toContain('Payment pending');
    expect((await bookingRow(app.db, bookingId)).status).toBe('pending');
    // Another device with the real session id: no private data.
    const stranger = await app.student().get(`/checkout/return?b=${bookingId}&session_id=${sessionId}`);
    const text = await pageText(stranger);
    expect(stranger.status).toBe(200);
    expect(text).not.toContain('Fay');
    expect(text).not.toContain('fake-return@example.com');
    expect(text).not.toContain('Secure group');
    expect(stranger.headers.get('Cache-Control')).toContain('no-store');
    expect((await bookingRow(app.db, bookingId)).status).toBe('pending');
    // Garbage ids.
    expect((await app.student().get('/checkout/return?b=bk_doesnotexist0000&session_id=x')).status).toBe(200);
    expect((await app.student().get('/checkout/return?b=../../etc')).status).toBe(200);
  });

  it('a payment whose amount does not match is held as an operator exception, not confirmed', async () => {
    const student = app.student();
    const sessionId = checkoutSessionId(await book(student, listing.slug, { email: 'mismatch@example.com' }));
    const bookingId = await bookingIdForEmail(app.db, 'mismatch@example.com');
    const paid = await metric(app.db, 'paid');
    app.stripe.pay(sessionId, { amountTotal: 100 });
    const hook = await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
    expect(hook.status).toBe(200);
    const row = await bookingRow(app.db, bookingId);
    expect(row.status).toBe('exception');
    expect(row.exception_reason).toContain('amount 100 does not match price 1500');
    expect(await metric(app.db, 'paid')).toBe(paid);
    const page = await pageText(await student.get(`/booking/${bookingId}`));
    expect(page).toContain('Being checked');
    expect(page).not.toContain('meet.example.com');
    expect(await pageText(await app.admin().get('/'))).toContain('Payment needs review');
  });

  it('rejects webhooks with invalid, stale or missing signatures and tampered bodies', async () => {
    const student = app.student();
    const sessionId = checkoutSessionId(await book(student, listing.slug, { email: 'badsig@example.com' }));
    const bookingId = await bookingIdForEmail(app.db, 'badsig@example.com');
    app.stripe.pay(sessionId);
    const object = app.stripe.sessions.get(sessionId)!;
    const wrongSecret = app.stripe.event('checkout.session.completed', object, { secret: 'whsec_attacker' });
    const stale = app.stripe.event('checkout.session.completed', object, { timestamp: nowSec() - 600 });
    const good = app.stripe.event('checkout.session.completed', object);
    const tampered = { body: good.body.replace('"livemode":false', '"livemode":false,"x":1'), signature: good.signature };
    expect((await app.webhook(wrongSecret)).status).toBe(400);
    expect((await app.webhook(stale)).status).toBe(400);
    expect((await app.webhook(tampered)).status).toBe(400);
    expect((await app.webhook({ body: good.body, signature: '' })).status).toBe(400);
    expect((await bookingRow(app.db, bookingId)).status).toBe('pending');
    expect(await app.db.prepare('SELECT COUNT(*) AS n FROM stripe_events WHERE id IN (?, ?)').bind(wrongSecret.id, stale.id).first()).toEqual({ n: 0 });
    // Events from live mode or another deployment are ignored.
    const live = app.stripe.event('checkout.session.completed', object, { livemode: true });
    expect(await (await app.webhook(live)).json()).toMatchObject({ ignored: 'mode' });
    const foreign = app.stripe.event('checkout.session.completed', { ...object, metadata: { ...object.metadata, env: 'production' } });
    expect(await (await app.webhook(foreign)).json()).toMatchObject({ outcome: 'ignored_foreign' });
    expect((await bookingRow(app.db, bookingId)).status).toBe('pending');
    // The genuine event confirms.
    expect((await app.webhook(good)).status).toBe(200);
    expect((await bookingRow(app.db, bookingId)).status).toBe('confirmed');
  });

  it('refuses every unauthenticated or wrongly authenticated dashboard request', async () => {
    const before = await app.db.prepare('SELECT COUNT(*) AS n FROM listings').first<{ n: number }>();
    const create = { title: 'Hacked', topic: 'x', price: '1', capacity: '8', cutoff_minutes: '120' };
    const forged = {
      'no assertion': app.anonAdmin(),
      'garbage assertion': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': 'not.a.jwt' }),
      'signed by another key': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({}, { wrongKey: true }) }),
      'unknown kid': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({}, { kid: 'other-kid' }) }),
      'alg none': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({}, { alg: 'none' }) }),
      'wrong audience': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({ aud: ['someone-elses-app'] }) }),
      'wrong issuer': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({ iss: 'https://evil.cloudflareaccess.com' }) }),
      expired: app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({ exp: nowSec() - 5 }) }),
      'not yet valid': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({ nbf: nowSec() + 3600 }) }),
      'unauthorised identity': app.anonAdmin({ 'Cf-Access-Jwt-Assertion': await app.access.sign({ email: 'intruder@example.com' }) }),
    };
    for (const [label, client] of Object.entries(forged)) {
      for (const path of ['/', '/listings/new', `/listings/${listing.id}`, `/listings/${listing.id}/roster.csv`, '/settings', '/assets/admin.js']) {
        const res = await client.get(path);
        expect(res.status, `${label} GET ${path}`).toBe(403);
        expect(await res.text()).toBe('Access denied.');
      }
      const post = await client.post('/listings', create);
      expect(post.status, `${label} POST`).toBe(403);
    }
    expect(await app.db.prepare('SELECT COUNT(*) AS n FROM listings').first<{ n: number }>()).toEqual(before);
    expect(TEAM_DOMAIN).toContain('cloudflareaccess');
    expect(ACCESS_AUD).toBeTruthy();
  });

  it('protects authenticated mutations against CSRF', async () => {
    const admin = app.admin();
    const before = await app.db.prepare('SELECT COUNT(*) AS n FROM listings').first<{ n: number }>();
    const create = { title: 'CSRF', topic: 'x', price: '15', capacity: '8', cutoff_minutes: '120' };
    expect((await admin.post('/listings', create)).status).toBe(403); // no token
    expect((await admin.post('/listings', { ...create, csrf: 'f'.repeat(40) })).status).toBe(403); // wrong token
    const token = await admin.csrf();
    expect((await admin.post('/listings', { ...create, csrf: token }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await admin.post('/listings', { ...create, csrf: token }, { origin: null })).status).toBe(403);
    const otherUser = app.admin({ email: 'tutor@example.com', sub: 'x' });
    expect((await otherUser.post('/listings', { ...create, csrf: token })).status).toBe(303); // same identity → same daily token
    expect(await app.db.prepare('SELECT COUNT(*) AS n FROM listings').first<{ n: number }>()).toEqual({ n: before!.n + 1 });
  });

  it('exports the roster only from the dashboard, escaping formula injection', async () => {
    const admin = app.admin();
    await admin.act(`/listings/${listing.id}/manual-booking`, {
      first_name: '=HYPERLINK("https://evil.example","x")',
      email: 'formula@example.com',
      payment_reference: '+cash',
      amount: '15',
    });
    const res = await admin.get(`/listings/${listing.id}/roster.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(csv).toContain(`'+cash`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await app.student().get(`/listings/${listing.id}/roster.csv`)).status).toBe(404); // not on the public Worker
  });

  it('sets security headers on public responses', async () => {
    const res = await app.student().get('/');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('rejects booking forms posted cross-site or without a passing Turnstile check', async () => {
    const student = app.student();
    const html = await (await student.get(`/session/${listing.slug}/book`)).text();
    const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!;
    const fields = { first_name: 'X', email: 'xsite@example.com', terms: '1', nonce, ref: 'direct', 'cf-turnstile-response': 'pass' };
    expect((await student.post(`/session/${listing.slug}/book`, fields, { origin: 'https://evil.example' })).status).toBe(403);
    // Browsers may send an opaque "null" Origin; only the browser-controlled Sec-Fetch-Site can vouch for it.
    expect((await student.post(`/session/${listing.slug}/book`, fields, { origin: 'null' })).status).toBe(403);
    expect((await student.post(`/session/${listing.slug}/book`, fields, { origin: 'null', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await student.post(`/session/${listing.slug}/book`, fields, { origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    const noCaptcha = await student.post(`/session/${listing.slug}/book`, { ...fields, 'cf-turnstile-response': 'fail' });
    expect(noCaptcha.status).toBe(422);
    expect(await pageText(noCaptcha)).toContain('I am human');
    expect(await app.db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE email = ?').bind('xsite@example.com').first()).toEqual({ n: 0 });
  });

  it('gives generic recovery instructions when an email already holds a seat', async () => {
    await bookAndPay(app, app.student(), listing.slug, 'taken@example.com', 'Tia');
    const res = await book(app.student(), listing.slug, { email: 'taken@example.com', firstName: 'Mallory' });
    expect(res.status).toBe(409);
    const text = await pageText(res);
    expect(text).toContain('already has a booking for this class');
    expect(text).not.toContain('Tia');
    expect(text).not.toContain('Confirmed');
  });
});

describe('mock admin identity is local-development only', () => {
  it('refuses to start the dashboard when DEV_ADMIN_EMAIL is set outside development', async () => {
    const app = await startApp({ adminEnv: { ENVIRONMENT: 'production', DEV_ADMIN_EMAIL: 'tutor@example.com', PUBLIC_ORIGIN: 'https://public.test', ADMIN_ORIGIN: 'https://admin.test' } });
    try {
      const res = await app.anonAdmin().get('/');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('configuration error');
    } finally {
      await app.close();
    }
  });

  it('ignores the mock identity on any host other than localhost, even in development', async () => {
    const app = await startApp({ adminEnv: { ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'tutor@example.com' }, adminRoutes: ['localhost/*'] });
    try {
      expect((await app.anonAdmin().get('/')).status).toBe(403); // host admin.test
      expect((await app.mf.dispatchFetch('http://admin.localhost/')).status).toBe(403); // not exactly localhost
      const local = await app.mf.dispatchFetch('http://localhost/');
      expect(local.status).toBe(200);
      expect(await local.text()).toContain('local dev identity');
    } finally {
      await app.close();
    }
  });
});
