import { expect } from 'vitest';
import type { Client, TestApp } from './app';

export const DAY = 86_400;
export const nowSec = () => Math.floor(Date.now() / 1000);

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36).padStart(4, '0')}x`;

export interface SeedLesson {
  start: number;
  minutes?: number;
  url?: string | null;
}

export async function seedListing(
  db: D1Database,
  opts: {
    slug: string;
    title?: string;
    kind?: 'single' | 'package';
    price?: number;
    capacity?: number;
    status?: 'draft' | 'published' | 'closed' | 'cancelled';
    cutoff?: number;
    lessons: SeedLesson[];
  },
): Promise<{ id: string; slug: string; lessonIds: string[] }> {
  const id = `lst_${opts.slug.replace(/[^a-z0-9]/g, '').slice(0, 12)}${(seq++).toString(36)}x`;
  const t = nowSec();
  await db
    .prepare(
      `INSERT INTO listings (id, slug, kind, title, topic, price_pence, capacity, cutoff_minutes, status, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, 'Python test questions', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, opts.slug, opts.kind ?? (opts.lessons.length > 1 ? 'package' : 'single'), opts.title ?? `Group ${opts.slug}`, opts.price ?? 1500, opts.capacity ?? 8, opts.cutoff ?? 120, opts.status ?? 'published', t, t, t)
    .run();
  const lessonIds: string[] = [];
  const sorted = [...opts.lessons].sort((a, b) => a.start - b.start);
  for (const [i, l] of sorted.entries()) {
    const lid = uid('les');
    lessonIds.push(lid);
    await db
      .prepare(`INSERT INTO lessons (id, listing_id, seq, starts_at, ends_at, meeting_url, uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(lid, id, i + 1, l.start, l.start + (l.minutes ?? 60) * 60, l.url === undefined ? `https://meet.example.com/${opts.slug}-${i + 1}` : l.url, `${lid}@kingston-tutoring`, t, t)
      .run();
  }
  const first = sorted[0]!.start;
  const last = Math.max(...sorted.map((l) => l.start + (l.minutes ?? 60) * 60));
  await db
    .prepare('UPDATE listings SET first_starts_at = ?, last_ends_at = ?, lesson_count = ?, bookings_close_at = ? WHERE id = ?')
    .bind(first, last, sorted.length, first - (opts.cutoff ?? 120) * 60, id)
    .run();
  return { id, slug: opts.slug, lessonIds };
}

/** Insert already-confirmed bookings directly (to fill seats quickly). */
export async function seedConfirmed(db: D1Database, listingId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  const t = nowSec();
  for (let i = 0; i < count; i++) {
    const id = `bk_${Math.random().toString(36).slice(2, 10)}${(seq++).toString(36).padStart(8, '0')}`.slice(0, 19);
    ids.push(id);
    await db
      .prepare(
        `INSERT INTO bookings (id, listing_id, email, first_name, source, status, price_pence, currency, terms_version, amount_paid_pence, confirmed_at, created_at, updated_at)
         SELECT ?, id, ?, 'Seeded', 'manual', 'confirmed', price_pence, currency, 'test', price_pence, ?, ?, ? FROM listings WHERE id = ?`,
      )
      .bind(id, `seeded-${id}@example.com`, t, t, t, listingId)
      .run();
  }
  return ids;
}

export function extract(text: string, re: RegExp): string {
  const m = re.exec(text);
  if (!m) throw new Error(`pattern ${re} not found in: ${text.slice(0, 400)}`);
  return m[1]!;
}

export async function openForm(student: Client, slug: string): Promise<{ nonce: string; ref: string; html: string }> {
  const res = await student.get(`/session/${slug}/book`);
  const html = await res.text();
  expect(res.status, html.slice(0, 300)).toBe(200);
  return { nonce: extract(html, /name="nonce" value="([^"]+)"/), ref: extract(html, /name="ref" value="([^"]*)"/), html };
}

export function bookingFields(form: { nonce: string; ref: string }, who: { firstName?: string; email: string }, extra: Record<string, string> = {}): Record<string, string> {
  return {
    first_name: who.firstName ?? 'Sam',
    email: who.email,
    terms: '1',
    early_request: '1',
    early_ack: '1',
    nonce: form.nonce,
    ref: form.ref,
    'cf-turnstile-response': 'pass',
    ...extra,
  };
}

/** Fill in the booking form and submit it; returns the raw (unfollowed) response. */
export async function book(student: Client, slug: string, who: { firstName?: string; email: string }, extra: Record<string, string> = {}): Promise<Response> {
  const form = await openForm(student, slug);
  return student.post(`/session/${slug}/book`, bookingFields(form, who, extra));
}

export function checkoutSessionId(res: Response): string {
  const loc = res.headers.get('Location') ?? '';
  const m = /\/c\/pay\/(cs_test_[a-f0-9]+)$/.exec(loc);
  if (!m) throw new Error(`expected a redirect to Checkout, got ${res.status} ${loc}`);
  return m[1]!;
}

export async function bookingIdForEmail(db: D1Database, email: string): Promise<string> {
  const row = await db.prepare('SELECT id FROM bookings WHERE email = ? ORDER BY created_at DESC LIMIT 1').bind(email).first<{ id: string }>();
  if (!row) throw new Error(`no booking for ${email}`);
  return row.id;
}

export async function bookingRow(db: D1Database, id: string): Promise<Record<string, any>> {
  const row = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first<Record<string, any>>();
  if (!row) throw new Error(`no booking ${id}`);
  return row;
}

export async function occupied(db: D1Database, listingId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE listing_id = ? AND status IN ('hold','pending','confirmed','exception')`)
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Book, pay at the (fake) Stripe Checkout, deliver the webhook. */
export async function bookAndPay(app: TestApp, student: Client, slug: string, email: string, firstName = 'Sam'): Promise<{ bookingId: string; sessionId: string }> {
  const res = await book(student, slug, { email, firstName });
  const sessionId = checkoutSessionId(res);
  app.stripe.pay(sessionId);
  const hook = await app.webhook(app.stripe.sessionEvent('checkout.session.completed', sessionId));
  expect(hook.status).toBe(200);
  return { bookingId: await bookingIdForEmail(app.db, email), sessionId };
}

export async function metric(db: D1Database, name: string, code?: string): Promise<number> {
  const row = code
    ? await db.prepare('SELECT SUM(count) AS n FROM daily_counts WHERE metric = ? AND code = ?').bind(name, code).first<{ n: number | null }>()
    : await db.prepare('SELECT SUM(count) AS n FROM daily_counts WHERE metric = ?').bind(name).first<{ n: number | null }>();
  return row?.n ?? 0;
}

/** Last Sunday of a month (UK clock changes happen at 01:00 UTC on these days). */
export function lastSunday(year: number, monthIndex: number): Date {
  const d = new Date(Date.UTC(year, monthIndex + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

/** Next UK spring-forward / fall-back dates at least `minDays` away. */
export function nextClockChange(kind: 'spring' | 'autumn', minDays = 16): Date {
  const earliest = Date.now() + minDays * DAY * 1000;
  for (let y = new Date().getUTCFullYear(); y < new Date().getUTCFullYear() + 3; y++) {
    const d = lastSunday(y, kind === 'spring' ? 2 : 9);
    if (d.getTime() > earliest) return d;
  }
  throw new Error('no clock change found');
}

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY * 1000);
}

/** Response body with the HTML entities our templates emit decoded, for readable assertions. */
export async function pageText(res: Response): Promise<string> {
  return decodeEntities(await res.text());
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#96;/g, '`')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The ok/err flash message an admin action redirected with. */
export function flash(res: Response): string {
  const loc = res.headers.get('Location') ?? '';
  const params = new URL(loc, 'https://admin.test').searchParams;
  return `${params.get('ok') ?? ''}${params.get('err') ?? ''}`;
}
