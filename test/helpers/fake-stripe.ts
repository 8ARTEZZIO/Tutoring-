/**
 * Stateful emulator for the slice of the Stripe API the app uses. It mirrors the behaviours the booking
 * engine relies on:
 *  - Idempotency-Key: a replay with the same key and body returns the saved response (including saved
 *    5xx); the same key with a different body is an idempotency_error; a concurrent replay gets 409.
 *  - Checkout Sessions: expires_at must be 30 min – 24 h ahead; sessions expire lazily after expires_at;
 *    /expire works only on open sessions.
 *  - Webhook signatures use Stripe's v1 scheme (HMAC-SHA256 of "t.payload").
 * Fault injection simulates lost responses, 5xx and validation failures.
 */
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';

type Json = Record<string, any>;

export interface FakeSession {
  id: string;
  object: 'checkout.session';
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  amount_total: number;
  currency: string;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  payment_intent: string | null;
  livemode: boolean;
  expires_at: number;
  created: number;
  url: string;
  success_url: string;
  cancel_url: string;
  customer_email: string | null;
  line_items: Json[];
  custom_text: Json;
  raw_body: string;
}

export type Fault =
  | { kind: 'drop' } // perform the operation but never answer in time (lost response)
  | { kind: 'status'; status: number; type?: string; message?: string } // answer with an error (saved under the key)
  | { kind: 'network' }; // fail before Stripe processes anything

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
const now = () => Math.floor(Date.now() / 1000);

export function parseStripeForm(body: string): Json {
  const out: Json = {};
  const params = new URLSearchParams(body);
  for (const [rawKey, value] of params) {
    const parts = rawKey.replace(/\]/g, '').split('[');
    let cursor: any = out;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]!);
      if (last) cursor[part] = value;
      else {
        cursor[part] ??= nextIsIndex ? [] : {};
        cursor = cursor[part];
      }
    });
  }
  return out;
}

export class FakeStripe {
  sessions = new Map<string, FakeSession>();
  paymentIntents = new Map<string, Json>();
  refunds = new Map<string, Json>();
  idempotency = new Map<string, { body: string; status: number; payload: Json } | 'in-progress'>();
  requests: { method: string; path: string; body: string; idempotencyKey: string | null }[] = [];
  createFaults: Fault[] = [];
  responseDelayMs = 0;
  /** Time Stripe spends creating a session; concurrent replays of the same key inside it get a 409. */
  processingDelayMs = 40;
  webhookSecret = 'whsec_test_fake_secret';
  apiKey = 'sk_test_fake';
  checkoutBase = 'https://checkout.stripe.test';

  get createCalls(): number {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/v1/checkout/sessions').length;
  }

  private json(status: number, payload: Json): Response {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private error(status: number, message: string, type = 'invalid_request_error', code?: string): Response {
    return this.json(status, { error: { type, message, code } });
  }

  private lazyExpire(s: FakeSession): void {
    if (s.status === 'open' && s.expires_at <= now()) s.status = 'expired';
  }

  private view(s: FakeSession, expandPi = false): Json {
    this.lazyExpire(s);
    const { raw_body: _raw, line_items: _li, success_url: _s, cancel_url: _c, custom_text: _ct, ...rest } = s;
    return {
      ...rest,
      url: s.status === 'open' ? s.url : null,
      customer_details: s.customer_email ? { email: s.customer_email } : null,
      payment_intent: expandPi && s.payment_intent ? this.paymentIntents.get(s.payment_intent) : s.payment_intent,
    };
  }

  /** Miniflare outboundService entry point (also handles non-Stripe hosts via `others`). */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : '';
    const key = request.headers.get('Idempotency-Key');
    this.requests.push({ method: request.method, path: url.pathname, body, idempotencyKey: key });
    if (request.headers.get('Authorization') !== `Bearer ${this.apiKey}`) return this.error(401, 'Invalid API Key provided');
    if (this.responseDelayMs) await new Promise((r) => setTimeout(r, this.responseDelayMs));

    if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') return this.createSession(body, key);
    let m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
    if (m && request.method === 'GET') {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.error(404, `No such checkout.session: '${m[1]}'`, 'invalid_request_error', 'resource_missing');
      return this.json(200, this.view(s, url.searchParams.getAll('expand[]').includes('payment_intent')));
    }
    m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
    if (m && request.method === 'POST') {
      const s = this.sessions.get(m[1]!);
      if (!s) return this.error(404, 'No such checkout.session', 'invalid_request_error', 'resource_missing');
      this.lazyExpire(s);
      if (s.status !== 'open') return this.error(400, `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session has a status of "${s.status}".`);
      s.status = 'expired';
      return this.json(200, this.view(s));
    }
    if (request.method === 'GET' && url.pathname === '/v1/checkout/sessions') {
      const gte = Number(url.searchParams.get('created[gte]') ?? 0);
      const lte = Number(url.searchParams.get('created[lte]') ?? Number.MAX_SAFE_INTEGER);
      const all = [...this.sessions.values()].filter((s) => s.created >= gte && s.created <= lte).sort((a, b) => b.created - a.created);
      return this.json(200, { object: 'list', data: all.map((s) => this.view(s)), has_more: false });
    }
    if (request.method === 'GET' && url.pathname === '/v1/refunds') {
      const pi = url.searchParams.get('payment_intent');
      const data = [...this.refunds.values()].filter((r) => r.payment_intent === pi);
      return this.json(200, { object: 'list', data, has_more: false });
    }
    return this.error(404, `Unrecognized request URL (${request.method}: ${url.pathname})`);
  }

  private async createSession(body: string, key: string | null): Promise<Response> {
    const fault = this.createFaults.shift();
    if (fault?.kind === 'network') throw new Error('simulated network failure');
    if (key) {
      const saved = this.idempotency.get(key);
      if (saved === 'in-progress') return this.error(409, 'There is currently another in-progress request using this Idempotent Key.', 'idempotency_error');
      if (saved) {
        if (saved.body !== body) {
          return this.error(400, 'Keys for idempotent requests can only be used with the same parameters they were first used with.', 'idempotency_error');
        }
        if (fault?.kind === 'drop') await new Promise((r) => setTimeout(r, 3000));
        return this.json(saved.status, saved.payload);
      }
    }
    const params = parseStripeForm(body);
    const save = (status: number, payload: Json) => {
      if (key) this.idempotency.set(key, { body, status, payload });
      return this.json(status, payload);
    };
    if (fault?.kind === 'status') {
      if (fault.status >= 500 && key) this.idempotency.set(key, { body, status: fault.status, payload: { error: { type: 'api_error', message: fault.message ?? 'Internal error' } } });
      return this.error(fault.status, fault.message ?? 'Simulated error', fault.type ?? (fault.status >= 500 ? 'api_error' : 'invalid_request_error'));
    }
    // Validation (no idempotent result is saved for validation failures, like Stripe).
    const expiresAt = Number(params.expires_at);
    if (params.mode !== 'payment') return this.error(400, 'Invalid mode');
    const li = params.line_items?.[0];
    if (!li?.price_data?.unit_amount || li.price_data.currency !== 'gbp' || li.quantity !== '1') return this.error(400, 'Invalid line_items');
    if (!params.success_url || !params.cancel_url) return this.error(400, 'Missing success_url or cancel_url');
    if (!(expiresAt >= now() + 30 * 60 - 5) || expiresAt > now() + 24 * 3600) {
      return this.error(400, 'The `expires_at` timestamp must be at least 30 minutes and at most 24 hours from Checkout Session creation.');
    }
    if (key) this.idempotency.set(key, 'in-progress');
    if (this.processingDelayMs) await new Promise((r) => setTimeout(r, this.processingDelayMs));
    const sid = id('cs_test');
    const session: FakeSession = {
      id: sid,
      object: 'checkout.session',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: Number(li.price_data.unit_amount) * Number(li.quantity),
      currency: li.price_data.currency,
      client_reference_id: params.client_reference_id ?? null,
      metadata: params.metadata ?? {},
      payment_intent: null,
      livemode: false,
      expires_at: expiresAt,
      created: now(),
      url: `${this.checkoutBase}/c/pay/${sid}`,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      customer_email: params.customer_email ?? null,
      line_items: params.line_items,
      custom_text: params.custom_text ?? {},
      raw_body: body,
    };
    this.sessions.set(sid, session);
    const response = save(200, this.view(session));
    if (fault?.kind === 'drop') {
      // The session now exists in Stripe, but the caller never hears back (its timeout fires first).
      await new Promise((r) => setTimeout(r, 3000));
    }
    return response;
  }

  // ---- Test controls ------------------------------------------------------------------------------

  /** Simulate the customer paying (optionally with a tampered amount for mismatch tests). */
  pay(sessionId: string, opts: { amountTotal?: number; currency?: string; livemode?: boolean } = {}): FakeSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    this.lazyExpire(s);
    if (s.status !== 'open') throw new Error(`session ${sessionId} is ${s.status}`);
    if (opts.amountTotal !== undefined) s.amount_total = opts.amountTotal;
    if (opts.currency) s.currency = opts.currency;
    if (opts.livemode !== undefined) s.livemode = opts.livemode;
    const piId = id('pi_test');
    this.paymentIntents.set(piId, {
      id: piId,
      object: 'payment_intent',
      amount: s.amount_total,
      amount_received: s.amount_total,
      currency: s.currency,
      status: 'succeeded',
      latest_charge: id('ch_test'),
      metadata: { booking_id: s.metadata.booking_id },
    });
    s.status = 'complete';
    s.payment_status = 'paid';
    s.payment_intent = piId;
    return s;
  }

  expire(sessionId: string): FakeSession {
    const s = this.sessions.get(sessionId)!;
    if (s.status === 'open') s.status = 'expired';
    return s;
  }

  /** Move a session's clock back so it looks older than it is. */
  age(sessionId: string, seconds: number): void {
    const s = this.sessions.get(sessionId)!;
    s.created -= seconds;
    s.expires_at -= seconds;
  }

  refund(paymentIntentId: string, amount: number, status = 'succeeded'): Json {
    const r = { id: id('re_test'), object: 'refund', amount, currency: 'gbp', status, reason: 'requested_by_customer', created: now(), payment_intent: paymentIntentId };
    this.refunds.set(r.id, r);
    return r;
  }

  sessionFor(bookingId: string): FakeSession | undefined {
    return [...this.sessions.values()].find((s) => s.client_reference_id === bookingId);
  }

  /** A Stripe event + signature header. */
  event(type: string, object: Json, opts: { secret?: string; timestamp?: number; livemode?: boolean } = {}): { body: string; signature: string; id: string } {
    const eventId = id('evt_test');
    const body = JSON.stringify({ id: eventId, object: 'event', type, livemode: opts.livemode ?? false, created: now(), data: { object } });
    const t = opts.timestamp ?? now();
    const sig = createHmac('sha256', opts.secret ?? this.webhookSecret).update(`${t}.${body}`).digest('hex');
    return { body, signature: `t=${t},v1=${sig}`, id: eventId };
  }

  sessionEvent(type: string, sessionId: string): { body: string; signature: string; id: string } {
    return this.event(type, this.view(this.sessions.get(sessionId)!));
  }

  // ---- Browser-facing fake Checkout page (Playwright tests) ---------------------------------------

  server: http.Server | null = null;
  onPaid: ((session: FakeSession) => Promise<void>) | null = null;

  async listen(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = /^\/c\/pay\/([^/]+)$/.exec(url.pathname);
      const s = m ? this.sessions.get(m[1]!) : undefined;
      if (!s) {
        res.writeHead(404).end('Not found');
        return;
      }
      if (req.method === 'POST') {
        this.pay(s.id);
        await this.onPaid?.(s);
        res.writeHead(303, { Location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) }).end();
        return;
      }
      const name = s.line_items[0]?.price_data?.product_data?.name ?? '';
      const desc = s.line_items[0]?.price_data?.product_data?.description ?? '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test Checkout</title>
<style>body{font:16px system-ui;margin:0;background:#f6f9fc;color:#1a1f36}main{max-width:420px;margin:0 auto;padding:24px 16px}.box{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 10px #0001}button{width:100%;min-height:48px;background:#635bff;color:#fff;border:0;border-radius:8px;font:600 16px system-ui}.muted{color:#697386;font-size:14px}</style></head>
<body><main><p class="muted">TEST MODE · local Stripe emulator</p><div class="box"><h1 style="font-size:20px">${name}</h1><p class="muted">${desc}</p><p style="font-size:28px;font-weight:700">£${(s.amount_total / 100).toFixed(2)}</p>
<p class="muted">${s.custom_text?.submit?.message ?? ''}</p><form method="post"><button type="submit">Book</button></form><p><a href="${s.cancel_url}">Back</a></p></div></main></body></html>`);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as { port: number };
    this.checkoutBase = `http://127.0.0.1:${address.port}`;
    return this.checkoutBase;
  }

  async close(): Promise<void> {
    if (this.server) await new Promise((r) => this.server!.close(r));
  }
}
