import { reconcileStale } from '../shared/booking';
import { type AppConfig, ConfigError, type Env, loadConfig } from '../shared/config';
import { Router, applySecurityHeaders, jsonResponse, log } from '../shared/http';
import { createStripeClient } from '../shared/stripe';
import { type Ctx, makeCtx } from './context';
import { handleBookGet, handleBookPost } from './pages/book';
import { renderCalendar } from './pages/calendar';
import { handleCancelled, handleRelease, handleResume, handleReturn } from './pages/checkout';
import { renderHome } from './pages/home';
import { handleInvite } from './pages/invite';
import { renderListing } from './pages/listing';
import { asset, errorPage, notFoundPage, renderPrivacy, renderSupport, renderTerms, robotsTxt } from './pages/misc';
import {
  handleCancelRequest,
  handleForget,
  handleIcs,
  handleLinkExchange,
  handleNewLink,
  handleRecoverPost,
  renderBooking,
  renderBookingIndex,
  renderRecover,
} from './pages/private';
import { handleLeave, handleWaitlistPost, renderLeave, renderWaitlist } from './pages/waitlist';
import { apiBookings, apiCancelRequest, apiConfig, apiForget, apiLink, appleAppSiteAssociation } from './api';
import { handleStripeWebhook } from './webhook';

const router = new Router<Ctx>()
  .get('/', (ctx) => renderHome(ctx))
  .get('/calendar', renderCalendar)
  .get('/session/:slug', (ctx, p) => renderListing(ctx, p.slug!))
  .get('/session/:slug/book', (ctx, p) => handleBookGet(ctx, p.slug!))
  .post('/session/:slug/book', (ctx, p) => handleBookPost(ctx, p.slug!))
  .get('/i/:token', (ctx, p) => handleInvite(ctx, p.token!))
  .get('/checkout/return', handleReturn)
  .get('/checkout/cancelled', handleCancelled)
  .get('/checkout/resume', handleResume)
  .post('/checkout/release', handleRelease)
  .get('/b/:token', (ctx, p) => handleLinkExchange(ctx, p.token!))
  .get('/booking', renderBookingIndex)
  .get('/booking/recover', (ctx) => renderRecover(ctx))
  .post('/booking/recover', handleRecoverPost)
  .post('/booking/forget', handleForget)
  .get('/booking/:id', (ctx, p) => renderBooking(ctx, p.id!))
  .get('/booking/:id/calendar.ics', (ctx, p) => handleIcs(ctx, p.id!))
  .post('/booking/:id/cancel-request', (ctx, p) => handleCancelRequest(ctx, p.id!))
  .post('/booking/:id/new-link', (ctx, p) => handleNewLink(ctx, p.id!))
  .get('/waitlist', (ctx) => renderWaitlist(ctx))
  .post('/waitlist', handleWaitlistPost)
  .get('/waitlist/leave/:token', (ctx, p) => renderLeave(ctx, p.token!))
  .post('/waitlist/leave/:token', (ctx, p) => handleLeave(ctx, p.token!))
  .get('/terms', renderTerms)
  .get('/privacy', renderPrivacy)
  .get('/robots.txt', () => robotsTxt())
  .get('/assets/app.css', (ctx) => asset(ctx, 'css'))
  .get('/assets/app.js', (ctx) => asset(ctx, 'js'))
  .get('/favicon.svg', (ctx) => asset(ctx, 'favicon'))
  .post('/webhooks/stripe', handleStripeWebhook)
  .post('/api/app/v1/link', apiLink)
  .post('/api/app/v1/bookings', apiBookings)
  .post('/api/app/v1/cancel-request', apiCancelRequest)
  .post('/api/app/v1/forget', apiForget)
  .get('/api/app/v1/config', apiConfig)
  .get('/.well-known/apple-app-site-association', (ctx) => appleAppSiteAssociation(ctx.env.APPLE_APP_IDS))
  .get('/support', renderSupport)
  .get('/healthz', (ctx) => jsonResponse({ ok: true, configured: ctx.cfg.problems.length === 0 }));

function publicCsp(cfg: AppConfig): string {
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://challenges.cloudflare.com",
    'frame-src https://challenges.cloudflare.com',
    // Chrome applies form-action to the redirect after the booking POST, so Checkout must be listed.
    `form-action 'self' ${cfg.stripe.checkoutOrigins.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

let loggedProblems = false;

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    let cfg: AppConfig;
    try {
      cfg = loadConfig(env, 'public');
    } catch (e) {
      log('error', 'config_error', { message: e instanceof ConfigError ? e.message : 'unknown' });
      return new Response('Service temporarily unavailable (configuration).', { status: 503 });
    }
    if (!loggedProblems && cfg.problems.length) {
      loggedProblems = true;
      log('warn', 'config_problems', { problems: cfg.problems });
    }
    const ctx = makeCtx(req, env, cfg, exec);
    let res: Response;
    try {
      const match = router.match(req.method, ctx.url.pathname);
      if (match === null) res = await notFoundPage(ctx);
      else if (match === 'method') res = new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD, POST' } });
      else res = await match.handler(ctx, match.params);
    } catch (e) {
      log('error', 'unhandled_error', { method: req.method, error: String(e).slice(0, 300) });
      try {
        res = await errorPage(ctx);
      } catch {
        res = new Response('Something went wrong', { status: 500 });
      }
    }
    if (req.method === 'HEAD') res = new Response(null, res);
    return applySecurityHeaders(res, publicCsp(cfg), ctx.setCookies);
  },

  async scheduled(_controller: ScheduledController, env: Env, _exec: ExecutionContext): Promise<void> {
    const cfg = loadConfig(env, 'public');
    if (!cfg.stripe.ready) {
      log('warn', 'cron_skipped', { reason: cfg.stripe.problem });
      return;
    }
    const deps = { db: env.DB, cfg, stripe: createStripeClient(cfg.stripe), now: Math.floor(Date.now() / 1000) };
    const result = await reconcileStale(deps, 10);
    if (result.checked) log('info', 'cron_reconcile', result);
  },
};
