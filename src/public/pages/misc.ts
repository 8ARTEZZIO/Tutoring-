import { type SafeHtml, html, paragraphs } from '../../shared/html';
import { htmlResponse } from '../../shared/http';
import { fillTemplate, sellerReady } from '../../shared/settings';
import { CSS_VERSION, FAVICON_SVG, JS_VERSION, publicLayout } from '../../shared/ui/public';
import { PUBLIC_JS } from '../../shared/ui/script';
import { PUBLIC_CSS } from '../../shared/ui/styles';
import type { Ctx } from '../context';

export async function messagePage(
  ctx: Ctx,
  opts: { title: string; body: SafeHtml; status?: number; private?: boolean; headExtra?: SafeHtml; turnstile?: boolean },
): Promise<Response> {
  const settings = await ctx.settings();
  const page = publicLayout({
    cfg: ctx.cfg,
    settings,
    title: `${opts.title} · Kingston Tutoring`,
    body: html`<div class="page"><div class="wrap narrow">${opts.body}</div></div>`,
    noindex: opts.private,
    turnstile: opts.turnstile,
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
  return messagePage(ctx, { title: 'Booking terms', body });
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
  return messagePage(ctx, { title: 'Privacy', body });
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
