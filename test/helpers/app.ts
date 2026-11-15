/**
 * Test harness: runs the real bundled Workers in workerd (Miniflare), both bound to the same D1
 * database, with every outbound request routed to local emulators (Stripe, Access JWKS, Turnstile).
 */
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { ACCESS_AUD, ADMIN_EMAIL, FakeAccess, TEAM_DOMAIN } from './fake-access';
import { FakeStripe } from './fake-stripe';

export const PUBLIC_ORIGIN = 'https://public.test';
export const ADMIN_ORIGIN = 'https://admin.test';
export const COMPAT_DATE = '2026-08-01';

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

let ipCounter = 1;

export class Client {
  cookies = new Map<string, string>();
  /** Each simulated visitor has its own client IP (rate limits are per IP). */
  ip = `198.51.100.${ipCounter++ % 250}`;
  constructor(
    private fetcher: FetchFn,
    readonly origin: string,
    private extraHeaders: () => Promise<Record<string, string>> = async () => ({}),
  ) {}

  private store(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx).trim();
      const value = pair!.slice(idx + 1).trim();
      const maxAge = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='));
      if ((maxAge && Number(maxAge.slice(8)) <= 0) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(
    method: string,
    path: string,
    opts: { form?: Record<string, string | string[]>; headers?: Record<string, string>; origin?: string | null; body?: string } = {},
  ): Promise<Response> {
    const url = path.startsWith('http') ? path : this.origin + path;
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (acceptance test)',
      'CF-Connecting-IP': this.ip,
      ...(await this.extraHeaders()),
      ...(opts.headers ?? {}),
    };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined = opts.body;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) for (const item of [v].flat()) p.append(k, item);
      body = p.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (method === 'POST' && opts.origin !== null) headers.Origin = opts.origin ?? this.origin;
    const res = await this.fetcher(url, { method, headers, body, redirect: 'manual' });
    this.store(res);
    return res;
  }

  get(path: string, opts: { headers?: Record<string, string> } = {}): Promise<Response> {
    return this.request('GET', path, opts);
  }

  post(path: string, form: Record<string, string | string[]>, opts: { origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    return this.request('POST', path, { ...opts, form });
  }

  /** Follow same-origin redirects (like a browser). */
  async follow(res: Response, max = 6): Promise<Response> {
    let current = res;
    while (current.status >= 300 && current.status < 400 && max-- > 0) {
      const loc = current.headers.get('Location')!;
      if (!loc.startsWith('/') && !loc.startsWith(this.origin)) break;
      current = await this.get(loc);
    }
    return current;
  }
}

export class AdminClient extends Client {
  async csrf(): Promise<string> {
    const res = await this.get('/');
    const text = await res.text();
    const m = /name="csrf" value="([a-f0-9]+)"/.exec(text);
    if (!m) throw new Error(`no csrf token (status ${res.status}): ${text.slice(0, 200)}`);
    return m[1]!;
  }

  async act(path: string, form: Record<string, string | string[]> = {}): Promise<Response> {
    return this.post(path, { csrf: await this.csrf(), ...form });
  }
}

export interface TestApp {
  mf: Miniflare;
  stripe: FakeStripe;
  access: FakeAccess;
  db: D1Database;
  student(): Client;
  admin(claims?: Record<string, unknown>): AdminClient;
  anonAdmin(headers?: Record<string, string>): Client;
  webhook(payload: { body: string; signature: string }, headers?: Record<string, string>): Promise<Response>;
  cron(): Promise<void>;
  turnstileCalls: string[];
  url: string | null;
  close(): Promise<void>;
}

export function publicEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN,
    ADMIN_ORIGIN,
    APP_SECRET: 'test-app-secret-0123456789-0123456789-abcdef',
    STRIPE_MODE: 'test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_fake_secret',
    STRIPE_API_BASE: 'https://api.stripe.test',
    STRIPE_CHECKOUT_ORIGIN: 'https://checkout.stripe.test',
    STRIPE_TIMEOUT_MS: '500',
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_VERIFY_URL: 'https://turnstile.test/siteverify',
    ...overrides,
  };
}

export function adminEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...publicEnv(),
    APP_SECRET: 'test-admin-secret-0123456789-0123456789-abcdef',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD,
    ADMIN_EMAILS: ADMIN_EMAIL,
    ...overrides,
  };
}

export async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/--.*$/gm, '');
    const statements = sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

export async function startApp(
  opts: { publicEnv?: Record<string, string>; adminEnv?: Record<string, string>; port?: number; stripe?: FakeStripe; adminRoutes?: string[] } = {},
): Promise<TestApp> {
  const stripe = opts.stripe ?? new FakeStripe();
  const access = await FakeAccess.create();
  const turnstileCalls: string[] = [];
  const outbound = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === 'api.stripe.test') return stripe.handle(request);
    if (url.origin === TEAM_DOMAIN && url.pathname === '/cdn-cgi/access/certs') return Response.json(access.jwks());
    if (url.origin === 'https://turnstile.test') {
      const form = new URLSearchParams(await request.text());
      turnstileCalls.push(form.get('response') ?? '');
      return Response.json({ success: form.get('secret') === 'turnstile-secret' && form.get('response') === 'pass' });
    }
    return new Response(`outbound host not allowed in tests: ${url.host}`, { status: 599 });
  };
  const listening = opts.port !== undefined;
  const mf = new Miniflare({
    ...(listening ? { host: '127.0.0.1', port: opts.port } : {}),
    workers: [
      {
        name: 'public',
        modules: true,
        scriptPath: '.test-build/public.js',
        compatibilityDate: COMPAT_DATE,
        d1Databases: { DB: 'kingston-tutoring-test' },
        bindings: publicEnv(opts.publicEnv),
        outboundService: outbound,
        routes: ['public.test/*'],
      },
      {
        name: 'admin',
        modules: true,
        scriptPath: '.test-build/admin.js',
        compatibilityDate: COMPAT_DATE,
        d1Databases: { DB: 'kingston-tutoring-test' },
        bindings: adminEnv(opts.adminEnv),
        outboundService: outbound,
        routes: ['admin.test/*', 'admin.localhost/*', ...(opts.adminRoutes ?? [])],
      },
    ],
  });
  const url = listening ? (await mf.ready).toString().replace(/\/$/, '') : null;
  const db = (await mf.getD1Database('DB', 'public')) as unknown as D1Database;
  await applyMigrations(db);
  const publicWorker = await mf.getWorker('public');
  // dispatchFetch routes by hostname (public.test / admin.test) and, unlike the getWorker() proxy, does
  // not apply Miniflare's dev-server Origin filter, so our own CSRF checks are what's being tested.
  const pubFetch: FetchFn = (u, init) => mf.dispatchFetch(u, init as never) as unknown as Promise<Response>;
  const admFetch: FetchFn = (u, init) => mf.dispatchFetch(u, init as never) as unknown as Promise<Response>;
  return {
    mf,
    stripe,
    access,
    db,
    turnstileCalls,
    url,
    student: () => new Client(pubFetch, PUBLIC_ORIGIN),
    admin: (claims = {}) => new AdminClient(admFetch, ADMIN_ORIGIN, async () => ({ 'Cf-Access-Jwt-Assertion': await access.sign(claims) })),
    anonAdmin: (headers = {}) => new Client(admFetch, ADMIN_ORIGIN, async () => headers),
    webhook: (payload, headers = {}) =>
      pubFetch(`${PUBLIC_ORIGIN}/webhooks/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Stripe-Signature': payload.signature, ...headers },
        body: payload.body,
      }),
    cron: async () => {
      await publicWorker.scheduled({ cron: '*/10 * * * *' });
    },
    close: async () => {
      await mf.dispose();
      await stripe.close();
    },
  };
}
