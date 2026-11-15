import { applySession, syncRefunds } from '../shared/booking';
import { APP_ID } from '../shared/config';
import { type BookingRow, getBooking } from '../shared/db';
import { jsonResponse, log } from '../shared/http';
import { verifyStripeSignature } from '../shared/stripe';
import type { Ctx } from './context';

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> & { id?: string; metadata?: Record<string, string> | null } };
}

const MAX_BODY = 512 * 1024;

/**
 * POST /webhooks/stripe. The signature is checked against the raw body before anything is parsed.
 * Event bodies are treated as hints only: the Checkout Session is re-fetched from Stripe and passed
 * through the same idempotent fulfilment path as browser returns and cron reconciliation.
 * Returning 5xx makes Stripe retry, so processing failures are never silently dropped.
 */
export async function handleStripeWebhook(ctx: Ctx): Promise<Response> {
  const secret = ctx.cfg.stripe.webhookSecret;
  if (!secret || !ctx.cfg.stripe.ready) {
    log('error', 'webhook_not_configured', {});
    return jsonResponse({ error: 'not configured' }, 503);
  }
  const raw = await ctx.req.text();
  if (raw.length > MAX_BODY) return jsonResponse({ error: 'too large' }, 413);
  const valid = await verifyStripeSignature(raw, ctx.req.headers.get('Stripe-Signature'), secret, ctx.now);
  if (!valid) {
    log('warn', 'webhook_bad_signature', {});
    return jsonResponse({ error: 'invalid signature' }, 400);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400);
  }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) {
    return jsonResponse({ error: 'invalid event' }, 400);
  }
  if (event.livemode !== ctx.cfg.stripe.livemode) return jsonResponse({ ignored: 'mode' });

  const rec = await ctx.db
    .prepare(
      `INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1
       RETURNING processed_at`,
    )
    .bind(event.id, event.type, ctx.now)
    .first<{ processed_at: number | null }>();
  if (rec?.processed_at) return jsonResponse({ duplicate: true });

  let result: { outcome: string; bookingId: string | null };
  try {
    result = await processEvent(ctx, event);
  } catch (e) {
    log('error', 'webhook_processing_failed', { event: event.id, type: event.type, error: String(e).slice(0, 200) });
    await ctx.db
      .prepare('UPDATE stripe_events SET outcome = ? WHERE id = ?')
      .bind(`error: ${String(e).slice(0, 150)}`, event.id)
      .run();
    return jsonResponse({ error: 'processing failed, retry' }, 500);
  }
  await ctx.db
    .prepare('UPDATE stripe_events SET processed_at = ?, outcome = ?, booking_id = ? WHERE id = ?')
    .bind(ctx.now, result.outcome, result.bookingId, event.id)
    .run();
  return jsonResponse({ received: true, outcome: result.outcome });
}

function piOf(obj: Record<string, unknown>): string | null {
  const pi = obj.payment_intent;
  if (typeof pi === 'string') return pi;
  if (pi && typeof pi === 'object' && typeof (pi as { id?: unknown }).id === 'string') return (pi as { id: string }).id;
  return null;
}

async function processEvent(ctx: Ctx, event: StripeEvent): Promise<{ outcome: string; bookingId: string | null }> {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const meta = obj.metadata ?? {};
      if (meta.app !== APP_ID || meta.env !== ctx.cfg.stripe.envTag) return { outcome: 'ignored_foreign', bookingId: null };
      const bookingId = meta.booking_id ?? (typeof obj.client_reference_id === 'string' ? obj.client_reference_id : null);
      const booking = bookingId ? await getBooking(ctx.db, bookingId) : null;
      if (!booking || typeof obj.id !== 'string') {
        log('warn', 'webhook_unknown_booking', { event: event.id });
        return { outcome: 'unknown_booking', bookingId: null };
      }
      const session = await ctx.stripe.retrieveCheckoutSession(obj.id);
      if (!session) throw new Error('Checkout Session could not be retrieved from Stripe');
      const outcome = await applySession(ctx.deps(), booking, session, `webhook:${event.type}`);
      return { outcome: outcome.kind, bookingId: booking.id };
    }
    case 'charge.refunded':
    case 'charge.refund.updated':
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed': {
      const pi = piOf(obj);
      if (!pi) return { outcome: 'ignored_no_payment', bookingId: null };
      const booking = await ctx.db.prepare('SELECT * FROM bookings WHERE payment_intent_id = ?').bind(pi).first<BookingRow>();
      if (!booking) return { outcome: 'ignored_unknown_payment', bookingId: null };
      const fresh = await syncRefunds(ctx.deps(), booking);
      return { outcome: `refund_${fresh.refund_state}`, bookingId: booking.id };
    }
    case 'charge.dispute.created': {
      const pi = piOf(obj);
      const booking = pi
        ? await ctx.db.prepare('SELECT * FROM bookings WHERE payment_intent_id = ?').bind(pi).first<BookingRow>()
        : null;
      if (!booking) return { outcome: 'ignored_unknown_payment', bookingId: null };
      await ctx.db
        .prepare('UPDATE bookings SET issue = ?, updated_at = ? WHERE id = ?')
        .bind('Payment disputed by the cardholder. Respond in the Stripe Dashboard.', ctx.now, booking.id)
        .run();
      return { outcome: 'dispute_flagged', bookingId: booking.id };
    }
    default:
      return { outcome: 'ignored_type', bookingId: null };
  }
}
