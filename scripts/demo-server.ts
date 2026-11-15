/**
 * Clickable demo of the pilot with no accounts or keys:
 *   - the real public and dashboard Workers running in workerd (Miniflare),
 *   - an in-memory D1 database seeded with clearly fictional classes and students,
 *   - the local Stripe emulator, with a stand-in Checkout page served on the site's own origin.
 *
 *   site       http://localhost:8787
 *   dashboard  http://localhost:8788   (open mock identity: DEMO ONLY, never deploy this)
 *
 * A small front proxy keeps everything single-origin so the demo also works when it is viewed through
 * a forwarded/embedded preview URL: it maps the browser's origin to the Workers' configured origin,
 * makes absolute links relative, allows embedding, and marks cookies SameSite=None over HTTPS.
 * Nothing here is used by the deployed Workers.
 */
import http from 'node:http';
import { Miniflare } from 'miniflare';
import { randomId } from '../src/shared/crypto';
import { refreshScheduleStatements } from '../src/shared/db';
import { saveSettings } from '../src/shared/settings';
import { ukLocalToUtc } from '../src/shared/time';
import { applyMigrations } from '../test/helpers/app';
import { FakeStripe } from '../test/helpers/fake-stripe';

const SITE_PORT = Number(process.env.DEMO_SITE_PORT ?? 8787);
const ADMIN_PORT = Number(process.env.DEMO_ADMIN_PORT ?? 8788);
const PUBLIC_ORIGIN = `http://localhost:${SITE_PORT}`;
const ADMIN_ORIGIN = `http://localhost:${ADMIN_PORT}`;
const STRIPE_PREFIX = '/__stripe';
const WEBHOOK_SECRET = 'whsec_demo_only_not_a_real_secret';
const BUILD = '.wrangler/demo-build';

// ---- Workers + Stripe emulator --------------------------------------------------------------------

const stripe = new FakeStripe();
stripe.webhookSecret = WEBHOOK_SECRET;
stripe.checkoutBase = PUBLIC_ORIGIN + STRIPE_PREFIX;
stripe.processingDelayMs = 150;

const shared = {
  ENVIRONMENT: 'development',
  PUBLIC_ORIGIN,
  ADMIN_ORIGIN,
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: stripe.apiKey,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_API_BASE: 'https://api.stripe.test',
  STRIPE_CHECKOUT_ORIGIN: PUBLIC_ORIGIN,
};
const outbound = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.host === 'api.stripe.test') return stripe.handle(request);
  return new Response('The demo has no internet access', { status: 503 });
};
const mf = new Miniflare({
  workers: [
    {
      name: 'public',
      modules: true,
      scriptPath: `${BUILD}/public.js`,
      compatibilityDate: '2026-08-01',
      d1Databases: { DB: 'demo' },
      bindings: { ...shared, APP_SECRET: 'demo-public-secret-not-for-production-use-0001' },
      outboundService: outbound,
    },
    {
      name: 'admin',
      modules: true,
      scriptPath: `${BUILD}/admin.js`,
      compatibilityDate: '2026-08-01',
      d1Databases: { DB: 'demo' },
      bindings: {
        ...shared,
        APP_SECRET: 'demo-admin-secret-not-for-production-use-0002',
        DEV_ADMIN_EMAIL: 'demo@example.com',
        ADMIN_EMAILS: 'demo@example.com',
      },
      outboundService: outbound,
    },
  ],
});
const db = (await mf.getD1Database('DB', 'public')) as unknown as D1Database;
await applyMigrations(db);
const publicWorker = await mf.getWorker('public');
const adminWorker = await mf.getWorker('admin');

stripe.onPaid = async (session) => {
  const event = stripe.sessionEvent('checkout.session.completed', session.id);
  await publicWorker.fetch(`${PUBLIC_ORIGIN}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': event.signature },
    body: event.body,
  });
};

// ---- Fictional seed data ----------------------------------------------------------------------------

const now = Math.floor(Date.now() / 1000);
function nextWeekday(weekday: number, minDaysAhead: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function plusDays(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function uk(date: string, time: string): number {
  const r = ukLocalToUtc(date, time);
  if (!r.ok) throw new Error(`seed time ${date} ${time}: ${r.reason}`);
  return r.ts;
}

interface SeedListing {
  slug: string;
  title: string;
  kind: 'single' | 'package';
  price: number;
  status?: 'draft' | 'published';
  summary: string;
  dates: [string, string, number][];
  students?: string[];
}

const pilotDay = nextWeekday(2, 3);
const groupDay = nextWeekday(4, 16);
const laterDay = nextWeekday(6, 45);
const fullDay = nextWeekday(3, 9);
const seed: SeedListing[] = [
  {
    slug: 'python-pilot',
    title: 'Python pilot: turning test questions into code',
    kind: 'single',
    price: 1500,
    summary: 'One 60-minute live session: one worked example, one fresh question under a timer, and one written correction.',
    dates: [[pilotDay, '18:00', 60]],
    students: ['Alex', 'Sam', 'Priya'],
  },
  {
    slug: 'first-four-session-group',
    title: 'First four-session group',
    kind: 'package',
    price: 8000,
    summary: 'Four fixed weekly sessions. One payment books your seat on all four dates.',
    dates: [0, 7, 14, 21].map((n) => [plusDays(groupDay, n), '18:00', 60] as [string, string, number]),
    students: ['Jordan', 'Mei', 'Tom', 'Aisha', 'Leo', 'Nina'],
  },
  {
    slug: 'later-four-session-group',
    title: 'Later four-session group',
    kind: 'package',
    price: 10800,
    summary: 'Four fixed Saturday sessions. One payment books your seat on all four dates.',
    dates: [0, 7, 14, 21].map((n) => [plusDays(laterDay, n), '11:00', 60] as [string, string, number]),
  },
  {
    slug: 'wednesday-evening-group',
    title: 'Wednesday evening group',
    kind: 'single',
    price: 1500,
    summary: 'A single evening session. This one is full, so it shows the waitlist.',
    dates: [[fullDay, '19:00', 60]],
    students: ['Omar', 'Ruth', 'Kai', 'Lena', 'Ben', 'Zoe', 'Ivan', 'Hana'],
  },
  {
    slug: 'revision-workshop',
    title: 'Revision workshop (draft)',
    kind: 'single',
    price: 1500,
    status: 'draft',
    summary: 'A draft to try the publish checks in the dashboard.',
    dates: [[nextWeekday(1, 30), '17:00', 90]],
  },
];

await saveSettings(
  db,
  {
    seller_name: 'Demo Tutor (fictional)',
    seller_address: '1 Demo Street, Kingston upon Thames (fictional address)',
    seller_email: 'demo@example.com',
  },
  'demo-seed',
  now,
);

let firstGroupId = '';
let fullGroupId = '';
for (const l of seed) {
  const id = randomId('lst', 12);
  if (l.slug === 'first-four-session-group') firstGroupId = id;
  if (l.slug === 'wednesday-evening-group') fullGroupId = id;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO listings (id, slug, kind, title, topic, summary, price_pence, capacity, cutoff_minutes, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Python test questions', ?, ?, 8, 120, ?, ?, ?, ?)`,
      )
      .bind(id, l.slug, l.kind, l.title, l.summary, l.price, l.status ?? 'published', l.status === 'draft' ? null : now, now, now),
  ];
  l.dates.forEach(([date, time, minutes], i) => {
    const lessonId = randomId('les', 12);
    const start = uk(date, time);
    statements.push(
      db
        .prepare(`INSERT INTO lessons (id, listing_id, starts_at, ends_at, meeting_url, uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(lessonId, id, start, start + minutes * 60, `https://meet.example.com/demo-${l.slug}-${i + 1}`, `${lessonId}@kingston-tutoring`, now, now),
    );
  });
  statements.push(...refreshScheduleStatements(db, id, now));
  for (const [i, name] of (l.students ?? []).entries()) {
    const manual = name === 'Leo';
    statements.push(
      db
        .prepare(
          `INSERT INTO bookings (id, listing_id, email, first_name, source, source_code, status, price_pence, currency, terms_version,
             amount_paid_pence, payment_reference, confirmed_at, cancel_requested_at, cancel_request_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, 'gbp', '2026-11-15.1', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          randomId('bk'),
          id,
          `${name.toLowerCase()}@example.com`,
          name,
          manual ? 'manual' : 'web',
          manual ? 'manual' : i % 2 ? 'qr-demo' : 'direct',
          l.price,
          l.price,
          manual ? 'Bank transfer (demo)' : null,
          now - (i + 1) * 3600,
          name === 'Aisha' ? now - 1800 : null,
          name === 'Aisha' ? 'I have a lab session clash on the third date.' : null,
          now - (i + 1) * 3600,
          now - (i + 1) * 3600,
        ),
    );
  }
  await db.batch(statements);
}
await db.batch([
  db
    .prepare(`INSERT INTO invites (id, kind, listing_id, code, channel, created_at, created_by) VALUES (?, 'share', ?, 'qr-demo', 'qr', ?, 'demo-seed')`)
    .bind(randomId('inv', 12), firstGroupId, now),
  ...[
    ['ella@example.com', 'Ella', 'Wed,Thu', 1, 0],
    ['finn@example.com', null, 'Wed', 1, 1],
  ].map(([email, name, days, alert, weekly]) =>
    db
      .prepare(
        `INSERT INTO waitlist (id, listing_key, email, first_name, preferred_days, wants_seat_alert, wants_weekly_question, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(randomId('wl'), fullGroupId, email, name, days, alert, weekly, now - 7200, now - 7200),
  ),
]);

// ---- Single-origin front proxy ------------------------------------------------------------------------

function externalOrigin(req: http.IncomingMessage, fallbackPort: number): { origin: string; https: boolean } {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) || 'http';
  const host = first(req.headers['x-forwarded-host']) || req.headers.host || `localhost:${fallbackPort}`;
  return { origin: `${proto}://${host}`, https: proto === 'https' };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function serve(target: 'public' | 'admin', port: number): http.Server {
  const internal = target === 'public' ? PUBLIC_ORIGIN : ADMIN_ORIGIN;
  const worker = target === 'public' ? publicWorker : adminWorker;
  return http.createServer(async (req, res) => {
    try {
      const ext = externalOrigin(req, port);
      // On the dashboard, guess the site's external origin (preview hosts usually embed the port).
      const publicExternal = target === 'public' ? ext.origin : ext.origin.includes(String(ADMIN_PORT)) ? ext.origin.replace(String(ADMIN_PORT), String(SITE_PORT)) : null;
      const toExternal = (text: string) => {
        let out = text.split(internal).join(ext.origin);
        if (publicExternal && target === 'admin') out = out.split(PUBLIC_ORIGIN).join(publicExternal);
        return out;
      };
      const url = new URL(req.url ?? '/', internal);

      if (target === 'public' && url.pathname.startsWith(`${STRIPE_PREFIX}/`)) {
        const handled = await stripe.serveCheckout(req, res, url.pathname.slice(STRIPE_PREFIX.length), (u) => (u.startsWith(internal) ? u.slice(internal.length) : u));
        if (!handled) res.writeHead(404).end('Not found');
        return;
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || ['host', 'connection', 'accept-encoding', 'content-length', 'keep-alive', 'transfer-encoding'].includes(key)) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const origin = headers.get('origin');
      if (origin && (origin === ext.origin || (origin === 'null' && headers.get('sec-fetch-site') === 'same-origin'))) {
        headers.set('origin', internal);
      }
      headers.set('CF-Connecting-IP', (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1');
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const response = (await worker.fetch(url.toString(), { method: req.method, headers, body, redirect: 'manual' } as never)) as unknown as Response;

      const out: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (['content-length', 'content-encoding', 'x-frame-options', 'set-cookie', 'transfer-encoding', 'mf-content-encoding'].includes(key)) return;
        if (key === 'content-security-policy') {
          out[key] = value.replace(/;\s*frame-ancestors 'none'/, ''); // the preview pane may embed the page
          return;
        }
        if (key === 'location') {
          out[key] = value.startsWith(internal) ? value.slice(internal.length) || '/' : value;
          return;
        }
        out[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) {
        out['set-cookie'] = cookies.map((c) => (ext.https ? c.replace(/;\s*SameSite=Lax/i, '; SameSite=None; Secure; Partitioned') : c));
      }
      const type = response.headers.get('content-type') ?? '';
      let payload: Buffer | string = Buffer.from(await response.arrayBuffer());
      if (/text\/html|text\/calendar/.test(type)) payload = toExternal(payload.toString('utf8'));
      res.writeHead(response.status, out);
      res.end(req.method === 'HEAD' ? undefined : payload);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Demo proxy error: ${String(e)}`);
    }
  });
}

const site = serve('public', SITE_PORT);
const dashboard = serve('admin', ADMIN_PORT);
await new Promise<void>((resolve) => site.listen(SITE_PORT, '0.0.0.0', resolve));
await new Promise<void>((resolve) => dashboard.listen(ADMIN_PORT, '0.0.0.0', resolve));

const cron = setInterval(() => {
  publicWorker.scheduled({ cron: '*/10 * * * *' }).catch(() => undefined);
}, 60_000);

console.log(`
  Demo running with fictional data (in memory; restarting resets it)
  Site:       http://localhost:${SITE_PORT}
  Dashboard:  http://localhost:${ADMIN_PORT}   (open demo identity, never deploy this)
  Payments:   stand-in Stripe Checkout page; press "Book" to simulate a successful card payment
`);

async function shutdown(): Promise<void> {
  clearInterval(cron);
  site.close();
  dashboard.close();
  await mf.dispose();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
