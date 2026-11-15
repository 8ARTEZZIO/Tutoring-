import { type AccessGrant, readCookieTokens, resolveAccess } from '../shared/access';
import type { Deps } from '../shared/booking';
import type { AppConfig, Env } from '../shared/config';
import {
  type ListingRow,
  availabilityOf,
  lessonsByListing,
  seatCounts,
} from '../shared/db';
import { clientIp, parseCookies } from '../shared/http';
import { type Settings, getSettings } from '../shared/settings';
import { type StripeClient, createStripeClient } from '../shared/stripe';
import type { ListingView } from '../shared/ui/public';

export interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  cfg: AppConfig;
  db: D1Database;
  exec: ExecutionContext;
  now: number;
  ip: string;
  cookies: Record<string, string>;
  setCookies: string[];
  stripe: StripeClient;
  deps(): Deps;
  settings(): Promise<Settings>;
  paused(): Promise<boolean>;
  access(): Promise<Map<string, AccessGrant>>;
}

export function makeCtx(req: Request, env: Env, cfg: AppConfig, exec: ExecutionContext, stripe?: StripeClient): Ctx {
  const now = Math.floor(Date.now() / 1000);
  const client = stripe ?? createStripeClient(cfg.stripe);
  let settingsP: Promise<Settings> | null = null;
  let accessP: Promise<Map<string, AccessGrant>> | null = null;
  const cookies = parseCookies(req.headers.get('Cookie'));
  const ctx: Ctx = {
    req,
    url: new URL(req.url),
    env,
    cfg,
    db: env.DB,
    exec,
    now,
    ip: clientIp(req),
    cookies,
    setCookies: [],
    stripe: client,
    deps: () => ({ db: env.DB, cfg, stripe: client, now }),
    settings: () => (settingsP ??= getSettings(env.DB)),
    paused: async () => cfg.bookingsPausedByEnv || (await ctx.settings()).bookings_paused === '1',
    access: () => (accessP ??= resolveAccess(env.DB, readCookieTokens(cookies, cfg))),
  };
  return ctx;
}

export async function loadViews(ctx: Ctx, listings: ListingRow[]): Promise<ListingView[]> {
  const ids = listings.map((l) => l.id);
  const [lessons, counts, paused] = await Promise.all([lessonsByListing(ctx.db, ids), seatCounts(ctx.db, ids), ctx.paused()]);
  return listings.map((listing) => ({
    listing,
    lessons: lessons.get(listing.id) ?? [],
    availability: availabilityOf(listing, counts.get(listing.id), ctx.now, paused),
  }));
}

export async function loadView(ctx: Ctx, listing: ListingRow): Promise<ListingView> {
  return (await loadViews(ctx, [listing]))[0]!;
}

/** Public visibility: drafts never; everything else shows its state. */
export function isPublicListing(listing: ListingRow | null): listing is ListingRow {
  return Boolean(listing && listing.status !== 'draft');
}
