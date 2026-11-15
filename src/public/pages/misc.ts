import { type SafeHtml, html, paragraphs } from '../../shared/html';
import { htmlResponse } from '../../shared/http';
import { fillTemplate, sellerReady } from '../../shared/settings';
import { CSS_VERSION, FAVICON_SVG, JS_VERSION, publicLayout } from '../../shared/ui/public';
import { PUBLIC_JS } from '../../shared/ui/script';
import { PUBLIC_CSS } from '../../shared/ui/styles';
import type { Ctx } from '../context';

export async function messagePage(
  ctx: Ctx,
  opts: { title: string; body: SafeHtml; status?: number; private?: boolean; headExtra?: SafeHtml; turnstile?: boolean; appView?: boolean },
): Promise<Response> {
  const settings = await ctx.settings();
  const page = publicLayout({
    cfg: ctx.cfg,
    settings,
    title: `${opts.title} · Kingston Tutoring`,
    body: html`<div class="page"><div class="wrap narrow">${opts.body}</div></div>`,
    noindex: opts.private || opts.appView,
    turnstile: opts.turnstile,
    appView: opts.appView,
  });
  // Optional extra head content (e.g. meta refresh) is injected after <head>.
  const text = opts.headExtra ? String(page).replace('<head>', `<head>${String(opts.headExtra)}`) : String(page);
  return htmlResponse(text, { status: opts.status ?? 200, private: opts.private });
}

export async function notFoundPage(ctx: Ctx): Promise<Response> {
  return messagePage(ctx, {
    title: 'Not found',
    status: 404,
    body: html`<h1>Page not found</h1><p>That page doesn't exist or is no longer available.</p>
      <div class="actions"><a class="btn btn-primary" href="/">See upcoming classes</a><a class="btn btn-secondary" href="/calendar">Calendar</a></div>`,
  });
}

export async function errorPage(ctx: Ctx): Promise<Response> {
  return messagePage(ctx, {
    title: 'Something went wrong',
    status: 500,
    private: true,
    body: html`<h1>Something went wrong</h1><p>Sorry, that didn't work. Nothing has been charged unless you completed payment on Stripe. Please try again in a minute.</p>
      <div class="actions"><a class="btn btn-primary" href="/">Back to the start</a></div>`,
  });
}

export function sellerBox(s: Awaited<ReturnType<Ctx['settings']>>): SafeHtml {
  if (!sellerReady(s)) {
    return html`<div class="notice small">Seller details: ${s.seller_name || 'not yet published'}${s.seller_email ? html`, <a href="mailto:${s.seller_email}">${s.seller_email}</a>` : ''}</div>`;
  }
  return html`<p class="seller">Sold by <strong>${s.seller_name}</strong>, ${s.seller_address}. Contact: <a href="mailto:${s.seller_email}">${s.seller_email}</a>.${s.seller_extra ? html` ${s.seller_extra}` : ''}</p>`;
}

/** `?view=app`: the page as opened from the iPhone app (see publicLayout). */
export function isAppView(ctx: Ctx): boolean {
  return ctx.url.searchParams.get('view') === 'app';
}

export async function renderTerms(ctx: Ctx): Promise<Response> {
  const s = await ctx.settings();
  const body = html`<article class="legal">
    <h1>Booking terms</h1>
    <p class="muted">Version ${s.terms_version}</p>
    ${sellerBox(s)}
    ${paragraphs(s.terms_body)}
    <h2 id="cancellation">Cancellation information</h2>
    ${paragraphs(s.cancellation_summary)}
    <h2>Starting within 14 days</h2>
    <p>If a class starts within 14 days of booking, you'll be asked to confirm: “${s.early_start_request_text}” and “${s.early_start_ack_text}”</p>
  </article>`;
  return messagePage(ctx, { title: 'Booking terms', body, appView: isAppView(ctx) });
}

export async function renderPrivacy(ctx: Ctx): Promise<Response> {
  const s = await ctx.settings();
  const text = fillTemplate(s.privacy_body, {
    retention_leads_days: s.retention_leads_days,
    retention_unpaid_days: s.retention_unpaid_days,
  });
  const body = html`<article class="legal">
    <h1>Privacy notice</h1>
    <p class="muted">Version ${s.privacy_version}</p>
    ${sellerBox(s)}
    ${paragraphs(text)}
  </article>`;
  return messagePage(ctx, { title: 'Privacy', body, appView: isAppView(ctx) });
}

export function robotsTxt(): Response {
  const body = [
    'User-agent: *',
    'Disallow: /b/',
    'Disallow: /i/',
    'Disallow: /booking',
    'Disallow: /checkout/',
    'Disallow: /waitlist/leave/',
    'Disallow: /webhooks/',
    'Disallow: /api/',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

export function asset(ctx: Ctx, kind: 'css' | 'js' | 'favicon'): Response {
  const v = ctx.url.searchParams.get('v');
  const fresh = (kind === 'css' && v === CSS_VERSION) || (kind === 'js' && v === JS_VERSION);
  const cache = fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  if (kind === 'css') return new Response(PUBLIC_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': cache } });
  if (kind === 'js') return new Response(PUBLIC_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': cache } });
  return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
}

export async function renderSupport(ctx: Ctx): Promise<Response> {
  const s = await ctx.settings();
  const appView = isAppView(ctx);
  const suffix = appView ? '?view=app' : '';
  const email = s.seller_email.trim();
  const contact = email ? html`<a href="mailto:${email}">${email}</a>` : html`the contact address in your confirmation email`;
  const lost = appView
    ? html`Lost it? Email ${contact} and you'll be sent a new one.`
    : html`Lost it? <a href="/booking/recover">Ask for your private link</a>.`;
  const body = html`<article class="legal">
    <h1>Support</h1>
    <p>Questions about a booking, the website or the iPhone app: email ${contact}. Replies normally within two working days.</p>
    <h2>Find your booking</h2>
    <p>Your confirmation email contains a private link to your booking page with your dates, join links and calendar file. ${lost}</p>
    <h2>Using the iPhone app</h2>
    <ul>
      <li>Open your private link on your iPhone, or copy it and tap <strong>Add booking</strong> in the app.</li>
      <li>The app shows your dates in UK time (and your local time when you're elsewhere), the join link for each session, and can remind you before each class and add sessions to your calendar.</li>
      <li><strong>Remove from this iPhone</strong> deletes the booking from the phone and switches off the app's access key. Your booking itself is not cancelled.</li>
    </ul>
    <h2>Cancelling</h2>
    <p>Use <strong>Request cancellation</strong> on your booking page or in the app. See the <a href="/terms${suffix}">booking terms</a> for how refunds work.</p>
    <h2>Your data</h2>
    <p>To see or delete the information held about you, email ${contact}. Records needed for tax and accounting are kept as described in the <a href="/privacy${suffix}">privacy notice</a>.</p>
    <p class="small muted">Independent peer tutoring, not run by or affiliated with Kingston University.</p>
  </article>`;
  return messagePage(ctx, { title: 'Support', body, appView });
}
