import { type AppConfig, ConfigError, type Env, loadConfig } from '../shared/config';
import { type BookingRow, type LessonRow, type ListingRow, getLessons } from '../shared/db';
import { html } from '../shared/html';
import { Router, applySecurityHeaders, isSameOrigin, log, readForm } from '../shared/http';
import { createStripeClient } from '../shared/stripe';
import { FAVICON_SVG } from '../shared/ui/public';
import { PUBLIC_JS } from '../shared/ui/script';
import { PUBLIC_CSS } from '../shared/ui/styles';
import { authenticate, checkCsrf, csrfToken } from './auth';
import { type AdminCtx, makeAdminCtx } from './context';
import {
  handleAcceptException,
  handleCancelRequestHandled,
  handleCancelSeat,
  handleRecheck,
  handleReleaseRefunded,
  handleRevokeLinks,
  handleSyncRefunds,
  loadBooking,
  renderBookingAdmin,
} from './pages/bookings';
import {
  handleIssueForRequest,
  handleLinkRequestHandled,
  handlePause,
  handleReconcile,
  renderDashboard,
  renderLinkRequest,
} from './pages/dashboard';
import { handleCreateInvite, handleCreateShare, handleRevokeInvite } from './pages/invites';
import {
  handleAddLesson,
  handleCancelLesson,
  handleCancelListing,
  handleClose,
  handleCreateListing,
  handleDeleteDraft,
  handlePublish,
  handleSettle,
  handleUpdateLesson,
  handleUpdateListing,
  loadListingOr404,
  renderLessonEdit,
  renderListingPage,
  renderNewListing,
  renderPreview,
} from './pages/listings';
import { handleMarkSent, handlePrepare } from './pages/messages';
import { handleManualBooking, rosterCsv } from './pages/roster';
import { handleSaveSettings, renderSettings } from './pages/settings';
import { renderAudit, renderIssues, renderStats } from './pages/stats';
import { handleDeleteWaitlist, handlePurge, renderWaitlistAdmin } from './pages/waitlist';
import { ADMIN_CSS, ADMIN_JS, adminLayout } from './ui';

type Handler = (ctx: AdminCtx, params: Record<string, string>) => Promise<Response> | Response;

const notFound = (ctx: AdminCtx) => adminLayout(ctx, { title: 'Not found', status: 404, body: html`<h1>Not found</h1><p><a href="/">Overview</a></p>` });

function withListing(fn: (ctx: AdminCtx, listing: ListingRow) => Promise<Response>): Handler {
  return async (ctx, p) => {
    const listing = await loadListingOr404(ctx, p.id ?? '');
    return listing ? fn(ctx, listing) : notFound(ctx);
  };
}

function withLesson(fn: (ctx: AdminCtx, listing: ListingRow, lesson: LessonRow) => Promise<Response>): Handler {
  return async (ctx, p) => {
    const listing = await loadListingOr404(ctx, p.id ?? '');
    if (!listing) return notFound(ctx);
    const lesson = (await getLessons(ctx.db, listing.id)).find((l) => l.id === p.lessonId);
    return lesson ? fn(ctx, listing, lesson) : notFound(ctx);
  };
}

function withBooking(fn: (ctx: AdminCtx, booking: BookingRow) => Promise<Response>): Handler {
  return async (ctx, p) => {
    const booking = await loadBooking(ctx, p.id ?? '');
    return booking ? fn(ctx, booking) : notFound(ctx);
  };
}

const css = (body: string) => () => new Response(body, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });
const js = (body: string) => () => new Response(body, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=300' } });

const router = new Router<AdminCtx>()
  .get('/', renderDashboard)
  .post('/pause', handlePause)
  .post('/reconcile', handleReconcile)
  .get('/listings/new', (ctx) => renderNewListing(ctx))
  .post('/listings', handleCreateListing)
  .get('/listings/:id', withListing((ctx, l) => renderListingPage(ctx, l)))
  .post('/listings/:id/update', withListing(handleUpdateListing))
  .post('/listings/:id/lessons', withListing(handleAddLesson))
  .get('/listings/:id/lessons/:lessonId', withLesson((ctx, l, le) => renderLessonEdit(ctx, l, le)))
  .post('/listings/:id/lessons/:lessonId', withLesson(handleUpdateLesson))
  .post('/listings/:id/lessons/:lessonId/cancel', withLesson(handleCancelLesson))
  .post('/listings/:id/publish', withListing(handlePublish))
  .post('/listings/:id/close', withListing(handleClose))
  .post('/listings/:id/cancel', withListing(handleCancelListing))
  .post('/listings/:id/settle', withListing(handleSettle))
  .post('/listings/:id/delete', withListing(handleDeleteDraft))
  .get('/listings/:id/preview', withListing(renderPreview))
  .get('/listings/:id/roster.csv', withListing(rosterCsv))
  .post('/listings/:id/manual-booking', withListing(handleManualBooking))
  .post('/listings/:id/share-links', withListing((ctx, l) => handleCreateShare(ctx, l)))
  .post('/listings/:id/invites', withListing(handleCreateInvite))
  .post('/invites/share', (ctx) => handleCreateShare(ctx, null))
  .post('/invites/:id/revoke', (ctx, p) => handleRevokeInvite(ctx, p.id ?? ''))
  .get('/bookings/:id', withBooking(renderBookingAdmin))
  .post('/bookings/:id/recheck', withBooking(handleRecheck))
  .post('/bookings/:id/sync-refunds', withBooking(handleSyncRefunds))
  .post('/bookings/:id/release-refunded', withBooking(handleReleaseRefunded))
  .post('/bookings/:id/cancel-seat', withBooking(handleCancelSeat))
  .post('/bookings/:id/revoke-links', withBooking(handleRevokeLinks))
  .post('/bookings/:id/accept-exception', withBooking(handleAcceptException))
  .post('/bookings/:id/cancel-request-handled', withBooking(handleCancelRequestHandled))
  .post('/messages/prepare', handlePrepare)
  .post('/messages/sent', handleMarkSent)
  .get('/waitlist', renderWaitlistAdmin)
  .post('/waitlist/:id/delete', (ctx, p) => handleDeleteWaitlist(ctx, p.id ?? ''))
  .post('/retention/purge', handlePurge)
  .get('/settings', renderSettings)
  .post('/settings', handleSaveSettings)
  .get('/stats', renderStats)
  .get('/issues', renderIssues)
  .get('/audit', renderAudit)
  .get('/link-requests/:id', (ctx, p) => renderLinkRequest(ctx, p.id ?? ''))
  .post('/link-requests/:id/issue', (ctx, p) => handleIssueForRequest(ctx, p.id ?? ''))
  .post('/link-requests/:id/handled', (ctx, p) => handleLinkRequestHandled(ctx, p.id ?? ''))
  .get('/assets/admin.css', css(ADMIN_CSS))
  .get('/assets/admin.js', js(ADMIN_JS))
  .get('/assets/app.css', css(PUBLIC_CSS))
  .get('/assets/app.js', js(PUBLIC_JS))
  .get('/favicon.svg', () => new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml' } }));

const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function deny(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    let cfg: AppConfig;
    try {
      cfg = loadConfig(env, 'admin');
    } catch (e) {
      log('error', 'admin_config_error', { message: e instanceof ConfigError ? e.message : 'unknown' });
      return applySecurityHeaders(deny(503, 'Dashboard unavailable: configuration error.'), ADMIN_CSP);
    }
    const url = new URL(req.url);
    const now = Math.floor(Date.now() / 1000);
    const auth = await authenticate(req, url, cfg, now);
    if (!auth.ok) {
      log('warn', 'admin_denied', { reason: auth.reason, method: req.method });
      return applySecurityHeaders(deny(403, 'Access denied.'), ADMIN_CSP);
    }
    let form: URLSearchParams | null = null;
    if (req.method === 'POST') {
      if (!isSameOrigin(req, cfg.adminOrigin)) {
        log('warn', 'admin_csrf_origin', {});
        return applySecurityHeaders(deny(403, 'Cross-site request refused.'), ADMIN_CSP);
      }
      form = await readForm(req, 128 * 1024);
      if (!form || !(await checkCsrf(cfg, auth.email, now, form.get('csrf')))) {
        log('warn', 'admin_csrf_token', {});
        return applySecurityHeaders(deny(403, 'Form expired or invalid. Go back, reload the page and try again.'), ADMIN_CSP);
      }
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      return applySecurityHeaders(deny(405, 'Method not allowed.'), ADMIN_CSP);
    }
    const ctx = makeAdminCtx({
      req,
      url,
      env,
      cfg,
      db: env.DB,
      exec,
      now,
      stripe: createStripeClient(cfg.stripe),
      email: auth.email,
      via: auth.via,
      csrf: await csrfToken(cfg, auth.email, now),
      form,
    });
    let res: Response;
    try {
      const match = router.match(req.method, url.pathname);
      if (match === null) res = await notFound(ctx);
      else if (match === 'method') res = deny(405, 'Method not allowed.');
      else res = await match.handler(ctx, match.params);
    } catch (e) {
      log('error', 'admin_unhandled', { error: String(e).slice(0, 300) });
      res = adminLayout(ctx, { title: 'Error', status: 500, body: html`<h1>Something went wrong</h1><p class="mono small">${String(e).slice(0, 300)}</p><p><a href="/">Overview</a></p>` });
    }
    if (req.method === 'HEAD') res = new Response(null, res);
    return applySecurityHeaders(res, ADMIN_CSP);
  },
};
