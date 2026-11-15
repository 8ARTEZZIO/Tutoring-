/**
 * Edge cases for the iPhone app's JSON API (/api/app/v1/*) and universal-link file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, startApp } from '../helpers/app';
import { DAY, bookAndPay, book, bookingIdForEmail, checkoutSessionId, extract, flash, nowSec, pageText, seedListing } from '../helpers/flows';
import { fmtSlotUk } from '../../src/shared/time';

let ipSeq = 1;

async function api(app: TestApp, path: string, body: unknown, opts: { ip?: string; raw?: string; contentType?: string; method?: string } = {}): Promise<Response> {
  return app.mf.dispatchFetch(`https://public.test${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': opts.contentType ?? 'application/json', 'CF-Connecting-IP': opts.ip ?? `203.0.113.${ipSeq++ % 250}` },
    body: opts.method === 'GET' ? undefined : (opts.raw ?? JSON.stringify(body)),
  }) as unknown as Promise<Response>;
}

async function privateLink(app: TestApp, bookingId: string): Promise<string> {
  const html = await pageText(await app.admin().act('/messages/prepare', { template: 'confirmation', booking: bookingId }));
  return extract(html, /(https:\/\/public\.test\/b\/[A-Za-z0-9_-]{43})/);
}

async function addToApp(app: TestApp, link: string): Promise<{ token: string; booking: any }> {
  const res = await api(app, '/api/app/v1/link', { link });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { token: string; booking: any };
}

async function refresh(app: TestApp, tokens: unknown[]): Promise<any[]> {
  const res = await api(app, '/api/app/v1/bookings', { tokens });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: any[] }).results;
}

describe('app API', () => {
  let app: TestApp;
  let pkg: { id: string; slug: string; lessonIds: string[] };
  let starts: number[];
  let bookingId: string;
  let link: string;

  beforeAll(async () => {
    app = await startApp();
    const base = nowSec() + 20 * DAY;
    starts = [0, 7, 14, 21].map((d) => base + d * DAY);
    pkg = await seedListing(app.db, { slug: 'app-group', title: 'App group', price: 8000, lessons: starts.map((start) => ({ start })) });
    ({ bookingId } = await bookAndPay(app, app.student(), pkg.slug, 'app-student@example.com', 'Ada'));
    link = await privateLink(app, bookingId);
  });
  afterAll(async () => app?.close());

  it('exchanges a private link for a separate device token and returns the schedule', async () => {
    const { token, booking } = await addToApp(app, link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).not.toContain(token);
    expect(booking).toMatchObject({ id: bookingId, status: 'confirmed', title: 'App group', firstName: 'Ada', groupCancelled: false, canRequestCancellation: true });
    expect(booking.sessions).toHaveLength(4);
    booking.sessions.forEach((s: any, i: number) => {
      expect(s).toMatchObject({ number: i + 1, of: 4, startsAt: starts[i], endsAt: starts[i]! + 3600, cancelled: false, sequence: 0 });
      expect(s.meetingUrl).toBe(`https://meet.example.com/app-group-${i + 1}`);
      expect(fmtSlotUk(s.startsAt, s.endsAt)).toBe(`${s.ukDate}, ${s.ukTime}`);
      expect(s.uid).toBe(`${pkg.lessonIds[i]}@kingston-tutoring`);
    });
    const json = JSON.stringify(booking);
    expect(json).not.toContain('app-student@example.com'); // no email in the app payload
    expect(json).not.toContain('price');
    const rows = await app.db.prepare(`SELECT kind FROM access_tokens WHERE booking_id = ? AND created_by = 'ios-app'`).bind(bookingId).all();
    expect(rows.results).toEqual([{ kind: 'device' }]);
  });

  it('accepts the link however it was pasted and rejects anything that is not one', async () => {
    const token = link.split('/b/')[1]!;
    const variants = [
      token,
      `  ${link}\n`,
      `${link}/`,
      `${link}?utm=email`,
      `${link}#top`,
      `Your link: ${link} (keep it private).`,
      link.replace('https://', 'http://'),
      link.replace('https://public.test', 'https://another-host.example'),
      `<${link}>`,
    ];
    for (const v of variants) {
      const res = await api(app, '/api/app/v1/link', { link: v });
      expect(res.status, `variant ${JSON.stringify(v)}`).toBe(200);
    }
    const bad: unknown[] = ['', '   ', 'hello', token.slice(1), `${token}X`, `${link}X`, 42, null, ['x'], { link }, 'x'.repeat(5000)];
    for (const v of bad) {
      const res = await api(app, '/api/app/v1/link', { link: v });
      expect(res.status, `bad ${JSON.stringify(v).slice(0, 40)}`).toBe(400);
      expect(((await res.json()) as any).error).toBe('not_a_link');
    }
    const unknown = await api(app, '/api/app/v1/link', { link: `https://public.test/b/${'A'.repeat(43)}` });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error).toBe('link_not_valid');
  });

  it('refreshes many bookings at once, keeping results aligned with the tokens sent', async () => {
    const a = await addToApp(app, link);
    const b = await addToApp(app, link); // same booking added twice on one phone
    const other = await bookAndPay(app, app.student(), pkg.slug, 'other-app@example.com', 'Bo');
    const c = await addToApp(app, await privateLink(app, other.bookingId));
    const results = await refresh(app, [a.token, 'not-a-token', b.token, 'B'.repeat(43), c.token, a.token, 7]);
    expect(results.map((r) => (r.ok ? r.booking.id : r.error))).toEqual([bookingId, 'invalid', bookingId, 'revoked', other.bookingId, bookingId, 'invalid']);
    expect(await refresh(app, [])).toEqual([]);
    const tooMany = await api(app, '/api/app/v1/bookings', { tokens: Array.from({ length: 21 }, () => a.token) });
    expect(tooMany.status).toBe(400);
    expect((await api(app, '/api/app/v1/bookings', { tokens: 'abc' })).status).toBe(400);
    expect((await api(app, '/api/app/v1/bookings', {})).status).toBe(400);
  });

  it('reflects reschedules and cancelled sessions on refresh', async () => {
    const { token } = await addToApp(app, link);
    const admin = app.admin();
    const date = new Date((starts[1]! + 3600) * 1000);
    const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);
    const moved = await admin.act(`/listings/${pkg.id}/lessons/${pkg.lessonIds[1]}`, { date: dateKey, time: '20:30', duration: '60', meeting_url: 'https://meet.example.com/app-group-2' });
    expect(flash(moved)).toContain('affected');
    await admin.act(`/listings/${pkg.id}/lessons/${pkg.lessonIds[2]}/cancel`);
    const [r] = await refresh(app, [token]);
    const s = r.booking.sessions;
    expect(s[1]).toMatchObject({ uid: `${pkg.lessonIds[1]}@kingston-tutoring`, sequence: 1, number: 2, of: 3, cancelled: false });
    expect(s[1].ukTime).toContain('20:30');
    const cancelled = s.find((x: any) => x.uid.startsWith(pkg.lessonIds[2]!));
    expect(cancelled).toMatchObject({ cancelled: true, number: null, meetingUrl: null });
    expect(s.filter((x: any) => !x.cancelled).map((x: any) => x.number)).toEqual([1, 2, 3]);
  });

  it('records a cancellation request once, cleans the note, and refuses it when not allowed', async () => {
    const other = await bookAndPay(app, app.student(), pkg.slug, 'cancel-app@example.com', 'Cy');
    const { token } = await addToApp(app, await privateLink(app, other.bookingId));
    const note = `  Exam clash \u0007 on week 3. ${'x'.repeat(1200)}`;
    const first = await api(app, '/api/app/v1/cancel-request', { token, note });
    expect(first.status).toBe(200);
    const body = (await first.json()) as any;
    expect(body.booking).toMatchObject({ canRequestCancellation: false });
    expect(body.booking.cancelRequestedAt).toBeGreaterThan(0);
    await api(app, '/api/app/v1/cancel-request', { token, note: 'second note' });
    const row = await app.db.prepare('SELECT cancel_request_note FROM bookings WHERE id = ?').bind(other.bookingId).first<{ cancel_request_note: string }>();
    expect(row!.cancel_request_note.startsWith('Exam clash  on week 3.')).toBe(true);
    expect(row!.cancel_request_note.length).toBeLessThanOrEqual(1000);
    expect(await pageText(await app.admin().get('/'))).toContain('Cancellation requests (');
    expect((await api(app, '/api/app/v1/cancel-request', { token: 'C'.repeat(43) })).status).toBe(404);
    expect((await api(app, '/api/app/v1/cancel-request', { token: 12 })).status).toBe(404);
    // Pending bookings cannot be cancelled from the app.
    const pendingStudent = app.student();
    checkoutSessionId(await book(pendingStudent, pkg.slug, { email: 'pending-app@example.com' }));
    const pendingId = await bookingIdForEmail(app.db, 'pending-app@example.com');
    const { issueToken } = await import('../helpers/tokens');
    const pendingToken = await issueToken(app.db, pendingId);
    const refused = await api(app, '/api/app/v1/cancel-request', { token: pendingToken });
    expect(refused.status).toBe(409);
    const [pending] = await refresh(app, [pendingToken]);
    expect(pending.booking).toMatchObject({ status: 'pending', canRequestCancellation: false });
    expect(pending.booking.sessions.every((s: any) => s.meetingUrl === null)).toBe(true);
  });

  it('forgetting a device revokes only that device; the emailed link keeps working', async () => {
    const { token } = await addToApp(app, link);
    expect((await api(app, '/api/app/v1/forget', { token })).status).toBe(200);
    expect((await api(app, '/api/app/v1/forget', { token })).status).toBe(200); // idempotent
    expect((await api(app, '/api/app/v1/forget', { token: 'garbage' })).status).toBe(200);
    const [r] = await refresh(app, [token]);
    expect(r).toEqual({ ok: false, error: 'revoked' });
    const browser = app.student();
    const res = await browser.get(link.replace('https://public.test', ''));
    expect(res.status).toBe(303);
    // Forget cannot be used to kill an emailed link token.
    const linkToken = link.split('/b/')[1]!;
    await api(app, '/api/app/v1/forget', { token: linkToken });
    expect((await app.student().get(link.replace('https://public.test', ''))).status).toBe(303);
  });

  it("revoking a booking's links in the dashboard also signs the app out", async () => {
    const other = await bookAndPay(app, app.student(), pkg.slug, 'revoke-app@example.com', 'Dee');
    const otherLink = await privateLink(app, other.bookingId);
    const { token } = await addToApp(app, otherLink);
    await app.admin().act(`/bookings/${other.bookingId}/revoke-links`);
    expect((await refresh(app, [token]))[0]).toEqual({ ok: false, error: 'revoked' });
    expect((await api(app, '/api/app/v1/link', { link: otherLink })).status).toBe(404);
  });

  it('shows seat cancellations, payment reviews and group cancellations without join links', async () => {
    const seat = await bookAndPay(app, app.student(), pkg.slug, 'seat-app@example.com', 'Eve');
    const seatToken = (await addToApp(app, await privateLink(app, seat.bookingId))).token;
    await app.admin().act(`/bookings/${seat.bookingId}/cancel-seat`, { reason: 'Moved to another group' });
    const [s] = await refresh(app, [seatToken]);
    expect(s.booking).toMatchObject({ status: 'cancelled', groupCancelled: false, canRequestCancellation: false });
    expect(s.booking.sessions.every((x: any) => x.cancelled && x.meetingUrl === null)).toBe(true);

    await app.db.prepare(`UPDATE bookings SET status = 'exception', exception_reason = 'test' WHERE id = ?`).bind(bookingId).run();
    const reviewToken = (await addToApp(app, link)).token;
    const [rv] = await refresh(app, [reviewToken]);
    expect(rv.booking.status).toBe('review');
    expect(rv.booking.sessions.every((x: any) => x.meetingUrl === null)).toBe(true);
    await app.db.prepare(`UPDATE bookings SET status = 'confirmed', exception_reason = NULL WHERE id = ?`).bind(bookingId).run();

    const group = await seedListing(app.db, { slug: 'app-cancelled-group', lessons: [{ start: nowSec() + 25 * DAY }] });
    const g = await bookAndPay(app, app.student(), group.slug, 'group-app@example.com', 'Fin');
    const gToken = (await addToApp(app, await privateLink(app, g.bookingId))).token;
    await app.admin().act(`/listings/${group.id}/cancel`, { reason: 'Tutor unwell' });
    const [gc] = await refresh(app, [gToken]);
    expect(gc.booking).toMatchObject({ status: 'cancelled', groupCancelled: true, cancelReason: 'Tutor unwell', canRequestCancellation: false });
    expect(gc.booking.sessions.every((x: any) => x.cancelled && x.meetingUrl === null)).toBe(true);
  });

  it('never exposes a non-https call link', async () => {
    await app.db.prepare(`UPDATE lessons SET meeting_url = 'http://insecure.example/call' WHERE id = ?`).bind(pkg.lessonIds[0]).run();
    const { token } = await addToApp(app, link);
    const [r] = await refresh(app, [token]);
    expect(r.booking.sessions[0].meetingUrl).toBeNull();
    await app.db.prepare(`UPDATE lessons SET meeting_url = 'https://meet.example.com/app-group-1' WHERE id = ?`).bind(pkg.lessonIds[0]).run();
  });

  it('rejects malformed requests cleanly', async () => {
    const malformed = await api(app, '/api/app/v1/link', null, { raw: '{"link": ' });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error).toBe('invalid_json');
    expect((await api(app, '/api/app/v1/link', null, { raw: '[1,2]' })).status).toBe(400);
    expect((await api(app, '/api/app/v1/link', null, { raw: 'link=x', contentType: 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await api(app, '/api/app/v1/link', null, { raw: JSON.stringify({ link: 'x'.repeat(9000) }) })).status).toBe(413);
    expect((await api(app, '/api/app/v1/link', null, { method: 'GET' })).status).toBe(405);
    const res = await api(app, '/api/app/v1/bookings', { tokens: [] });
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rate-limits link attempts per client', async () => {
    const ip = '198.18.0.77';
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await api(app, '/api/app/v1/link', { link: 'nope' }, { ip })).status);
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it('serves app configuration without secrets', async () => {
    await app.admin().act('/settings', { seller_name: 'Config Seller', seller_address: '1 Config Road', seller_email: 'help@seller.example' });
    const res = await api(app, '/api/app/v1/config', null, { method: 'GET' });
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      apiVersion: 1,
      sellerName: 'Config Seller',
      supportEmail: 'help@seller.example',
      supportUrl: 'https://public.test/support?view=app',
      privacyUrl: 'https://public.test/privacy?view=app',
      termsUrl: 'https://public.test/terms?view=app',
    });
    expect(JSON.stringify(body)).not.toMatch(/sk_test|whsec|secret/i);
    const support = await pageText(await app.student().get('/support'));
    expect(support).toContain('help@seller.example');
    expect(support).toContain('Remove from this iPhone');
    expect(await pageText(await app.student().get('/privacy'))).toContain('The iPhone app');
  });

  it('opens policy and support pages from the app without links towards booking or payment', async () => {
    await app.admin().act('/settings', { seller_name: 'View Seller', seller_address: '2 View Road', seller_email: 'view@seller.example' });
    const towardsBooking = /href="\/(?:calendar|booking|session|i\/|#|")|href="\/"/;
    for (const path of ['/support?view=app', '/terms?view=app', '/privacy?view=app']) {
      const res = await app.student().get(path);
      expect(res.status, path).toBe(200);
      const page = await pageText(res);
      expect(page, path).not.toMatch(towardsBooking);
      expect(page, path).toContain('name="robots" content="noindex');
      expect(page, path).toContain('href="/support?view=app"');
      expect(page, path).toContain('view@seller.example');
    }
    const support = await pageText(await app.student().get('/support?view=app'));
    expect(support).toContain('href="/terms?view=app"');
    expect(support).toContain('href="/privacy?view=app"');
    expect(support).toContain("you'll be sent a new one");
    // The ordinary pages keep the full site navigation.
    const normal = await pageText(await app.student().get('/support'));
    expect(normal).toContain('href="/calendar"');
    expect(normal).toContain('href="/booking/recover"');
  });

  it('lets the operator register an App Review demo student on a hidden draft class', async () => {
    const draft = await seedListing(app.db, { slug: 'app-review-demo', title: 'App Review demo class', status: 'draft', lessons: [{ start: nowSec() + 30 * DAY }] });
    const html = await pageText(await app.admin().act(`/listings/${draft.id}/manual-booking`, { first_name: 'Reviewer', email: 'review@example.com', payment_reference: 'App Review demo', amount: '0' }));
    const demoLink = extract(html, /(https:\/\/public\.test\/b\/[A-Za-z0-9_-]{43})/);
    const { booking } = await addToApp(app, demoLink);
    expect(booking).toMatchObject({ status: 'confirmed', title: 'App Review demo class', firstName: 'Reviewer' });
    expect(booking.sessions[0].meetingUrl).toBe('https://meet.example.com/app-review-demo-1');
    expect((await app.student().get('/session/app-review-demo')).status).toBe(404); // still hidden from the public
    expect(await pageText(await app.student().get('/'))).not.toContain('App Review demo class');
  });
});

describe('universal links file', () => {
  it('is only served when app IDs are configured, and only valid IDs are listed', async () => {
    const plain = await startApp();
    try {
      expect((await plain.student().get('/.well-known/apple-app-site-association')).status).toBe(404);
    } finally {
      await plain.close();
    }
    const withIds = await startApp({ publicEnv: { APPLE_APP_IDS: 'ABCDE12345.uk.example.kingstontutoring, not valid, abcde12345.lowercase' } });
    try {
      const res = await withIds.student().get('/.well-known/apple-app-site-association');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/json');
      expect(await res.json()).toEqual({
        applinks: { details: [{ appIDs: ['ABCDE12345.uk.example.kingstontutoring'], components: [{ '/': '/b/*', comment: 'Private booking links open in the app' }] }] },
      });
    } finally {
      await withIds.close();
    }
  });
});
