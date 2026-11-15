import type { StripeConfig } from './config';
import { hmacHex, timingSafeEqual } from './crypto';

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  latest_charge?: string | null;
  metadata?: Record<string, string> | null;
}

export interface CheckoutSession {
  id: string;
  object: 'checkout.session';
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  payment_intent: string | StripePaymentIntent | null;
  livemode: boolean;
  expires_at: number;
  created: number;
  url: string | null;
  customer_details?: { email?: string | null } | null;
}

export interface StripeRefund {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | string;
  reason: string | null;
  created: number;
  payment_intent: string | null;
}

/**
 * 'definite' = Stripe certainly did not perform the operation (validation/auth errors).
 * 'uncertain' = it may or may not have happened (timeouts, network errors, 5xx, conflicts).
 */
export class StripeError extends Error {
  constructor(
    readonly certainty: 'definite' | 'uncertain',
    readonly status: number | null,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

export interface StripeClient {
  createCheckoutSession(body: string, idempotencyKey: string): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession | null>;
  expireCheckoutSession(id: string): Promise<CheckoutSession>;
  listCheckoutSessions(params: { createdGte: number; createdLte: number }): Promise<CheckoutSession[]>;
  listRefunds(paymentIntentId: string): Promise<StripeRefund[]>;
}

export function formEncode(pairs: [string, string | number | boolean][]): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

const ID_PATTERN = /^[A-Za-z0-9_]{3,255}$/;

export function createStripeClient(cfg: StripeConfig): StripeClient {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: string; query?: string; idempotencyKey?: string } = {},
  ): Promise<T> {
    if (!cfg.ready) throw new StripeError('definite', null, `Stripe is not configured: ${cfg.problem}`, 'not_configured');
    const url = `${cfg.apiBase}${path}${opts.query ? `?${opts.query}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cfg.secretKey}`,
      'Stripe-Version': cfg.apiVersion,
      'User-Agent': 'kingston-tutoring-pilot/0.1',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let status: number;
    let data: unknown;
    try {
      const res = await fetch(url, { method, headers, body: opts.body, signal: controller.signal });
      status = res.status;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
    } catch {
      throw new StripeError('uncertain', null, 'No response from Stripe (network error or timeout)', 'no_response');
    } finally {
      clearTimeout(timer);
    }
    if (status >= 200 && status < 300 && data && typeof data === 'object') return data as T;
    const err = (data as { error?: { message?: string; code?: string; type?: string } } | null)?.error ?? {};
    const message = err.message ?? `Stripe responded with HTTP ${status}`;
    const code = err.code ?? err.type ?? null;
    if (status >= 200 && status < 300) throw new StripeError('uncertain', status, 'Unreadable response from Stripe', 'bad_response');
    if (status >= 500 || status === 409 || status === 429 || err.type === 'idempotency_error') {
      throw new StripeError('uncertain', status, message, code);
    }
    throw new StripeError('definite', status, message, code);
  }

  return {
    createCheckoutSession(body, idempotencyKey) {
      return call<CheckoutSession>('POST', '/v1/checkout/sessions', { body, idempotencyKey });
    },
    async retrieveCheckoutSession(id) {
      if (!ID_PATTERN.test(id)) return null;
      try {
        return await call<CheckoutSession>('GET', `/v1/checkout/sessions/${id}`, { query: 'expand[]=payment_intent' });
      } catch (e) {
        if (e instanceof StripeError && e.status === 404) return null;
        throw e;
      }
    },
    expireCheckoutSession(id) {
      return call<CheckoutSession>('POST', `/v1/checkout/sessions/${id}/expire`, { body: '' });
    },
    async listCheckoutSessions({ createdGte, createdLte }) {
      const all: CheckoutSession[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query: string =
          `created[gte]=${createdGte}&created[lte]=${createdLte}&limit=100` + (after ? `&starting_after=${after}` : '');
        const res: { data?: CheckoutSession[]; has_more?: boolean } = await call('GET', '/v1/checkout/sessions', { query });
        const data: CheckoutSession[] = res.data ?? [];
        all.push(...data);
        if (!res.has_more || data.length === 0) break;
        after = data[data.length - 1]!.id;
      }
      return all;
    },
    async listRefunds(paymentIntentId) {
      const query = `payment_intent=${encodeURIComponent(paymentIntentId)}&limit=100`;
      const res = await call<{ data: StripeRefund[] }>('GET', '/v1/refunds', { query });
      return res.data ?? [];
    },
  };
}

export function paymentIntentId(session: CheckoutSession): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === 'string' ? pi : pi.id;
}

/** Verify a Stripe-Signature header (v1 scheme) against the raw request body. */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => timingSafeEqual(sig, expected));
}
