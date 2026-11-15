/**
 * Environment bindings and validated configuration.
 *
 * Anything other than ENVIRONMENT=development|test is treated as production, and production fails
 * closed: missing secrets disable the affected feature instead of silently weakening it.
 */

export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  PUBLIC_ORIGIN?: string;
  ADMIN_ORIGIN?: string;
  APP_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_MODE?: string;
  STRIPE_API_VERSION?: string;
  STRIPE_ENV_TAG?: string;
  STRIPE_TIMEOUT_MS?: string;
  /** Non-production only: point the Stripe client at a local emulator. */
  STRIPE_API_BASE?: string;
  /** Non-production only: extra allowed origin for Checkout redirect URLs. */
  STRIPE_CHECKOUT_ORIGIN?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Non-production only. */
  TURNSTILE_VERIFY_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  /** Mock Access identity. Honoured only in development on localhost. */
  DEV_ADMIN_EMAIL?: string;
  /** Emergency switch: "true" pauses all new bookings regardless of the dashboard setting. */
  BOOKINGS_PAUSED?: string;
}

export type EnvName = 'production' | 'development' | 'test';

export const APP_ID = 'kingston-tutoring';
export const DEFAULT_STRIPE_API_VERSION = '2025-03-31.basil';
export const STRIPE_PROD_API = 'https://api.stripe.com';
export const STRIPE_PROD_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
export const TURNSTILE_PROD_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface StripeConfig {
  ready: boolean;
  problem: string | null;
  secretKey: string;
  webhookSecret: string;
  mode: 'test' | 'live';
  livemode: boolean;
  apiBase: string;
  apiVersion: string;
  checkoutOrigins: string[];
  timeoutMs: number;
  envTag: string;
}

export interface AppConfig {
  envName: EnvName;
  isProduction: boolean;
  publicOrigin: string;
  adminOrigin: string;
  appSecret: string;
  stripe: StripeConfig;
  turnstile: {
    siteKey: string | null;
    secretKey: string | null;
    verifyUrl: string;
    /** When true and no secret is configured, protected forms are refused. */
    required: boolean;
  };
  access: {
    teamDomain: string;
    aud: string;
    adminEmails: string[];
    devAdminEmail: string | null;
  };
  bookingsPausedByEnv: boolean;
  /** Human-readable configuration problems (shown to the operator, logged once per isolate). */
  problems: string[];
}

export class ConfigError extends Error {}

function trimOrigin(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function isHttpsOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash;
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/';
  } catch {
    return false;
  }
}

export function loadConfig(env: Env, worker: 'public' | 'admin'): AppConfig {
  const raw = (env.ENVIRONMENT ?? '').trim().toLowerCase();
  const envName: EnvName = raw === 'development' ? 'development' : raw === 'test' ? 'test' : 'production';
  const isProduction = envName === 'production';
  const problems: string[] = [];

  const publicOrigin = trimOrigin(env.PUBLIC_ORIGIN);
  const adminOrigin = trimOrigin(env.ADMIN_ORIGIN);
  if (!publicOrigin || !(isProduction ? isHttpsOrigin(publicOrigin) : isOrigin(publicOrigin))) {
    throw new ConfigError('PUBLIC_ORIGIN must be set to the public site origin' + (isProduction ? ' (https)' : ''));
  }
  if (worker === 'admin' && (!adminOrigin || !(isProduction ? isHttpsOrigin(adminOrigin) : isOrigin(adminOrigin)))) {
    throw new ConfigError('ADMIN_ORIGIN must be set to the dashboard origin' + (isProduction ? ' (https)' : ''));
  }

  let appSecret = env.APP_SECRET ?? '';
  if (appSecret.length < 32) {
    if (isProduction) throw new ConfigError('APP_SECRET must be a random secret of at least 32 characters');
    appSecret = appSecret || 'insecure-development-secret-not-for-production-use';
  }

  // --- Stripe -------------------------------------------------------------------------------------
  const mode: 'test' | 'live' = (env.STRIPE_MODE ?? 'test').trim().toLowerCase() === 'live' ? 'live' : 'test';
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  let stripeProblem: string | null = null;
  const testKey = /^(sk|rk)_test_[A-Za-z0-9_]+$/.test(secretKey);
  const liveKey = /^(sk|rk)_live_[A-Za-z0-9_]+$/.test(secretKey);
  if (!secretKey || secretKey.includes('REPLACE_ME')) {
    stripeProblem = 'STRIPE_SECRET_KEY is not set';
  } else if (mode === 'test' && !testKey) {
    stripeProblem = 'STRIPE_MODE is "test" but STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_)';
  } else if (mode === 'live' && !liveKey) {
    stripeProblem = 'STRIPE_MODE is "live" but STRIPE_SECRET_KEY is not a live-mode key';
  } else if (mode === 'live' && !isProduction) {
    stripeProblem = 'Live Stripe keys are refused outside production';
  }
  if (stripeProblem) problems.push(stripeProblem);

  let apiBase = STRIPE_PROD_API;
  const checkoutOrigins = [STRIPE_PROD_CHECKOUT_ORIGIN];
  if (!isProduction) {
    if (env.STRIPE_API_BASE) apiBase = trimOrigin(env.STRIPE_API_BASE);
    if (env.STRIPE_CHECKOUT_ORIGIN) checkoutOrigins.push(trimOrigin(env.STRIPE_CHECKOUT_ORIGIN));
  }
  const timeoutMs = Math.min(Math.max(Number(env.STRIPE_TIMEOUT_MS ?? '') || 10000, 100), 25000);

  // --- Turnstile ----------------------------------------------------------------------------------
  const siteKey = (env.TURNSTILE_SITE_KEY ?? '').trim() || null;
  const tSecret = (env.TURNSTILE_SECRET_KEY ?? '').trim() || null;
  const verifyUrl = !isProduction && env.TURNSTILE_VERIFY_URL ? env.TURNSTILE_VERIFY_URL : TURNSTILE_PROD_VERIFY;
  if (isProduction && worker === 'public' && (!siteKey || !tSecret)) {
    problems.push('Turnstile is not configured: public forms are refused until TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set');
  }

  // --- Access (admin) -----------------------------------------------------------------------------
  const teamDomain = trimOrigin(env.ACCESS_TEAM_DOMAIN);
  const aud = (env.ACCESS_AUD ?? '').trim();
  const adminEmails = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const devEmail = (env.DEV_ADMIN_EMAIL ?? '').trim().toLowerCase() || null;
  if (worker === 'admin') {
    if (devEmail && envName !== 'development') {
      // A mock identity must never be reachable outside local development.
      throw new ConfigError('DEV_ADMIN_EMAIL is set outside ENVIRONMENT=development; refusing to start');
    }
    if (envName !== 'development') {
      if (!teamDomain || (isProduction && !isHttpsOrigin(teamDomain))) {
        problems.push('ACCESS_TEAM_DOMAIN is not configured');
      }
      if (!aud) problems.push('ACCESS_AUD is not configured');
      if (adminEmails.length === 0) problems.push('ADMIN_EMAILS is not configured');
    }
  }

  return {
    envName,
    isProduction,
    publicOrigin,
    adminOrigin,
    appSecret,
    stripe: {
      ready: stripeProblem === null,
      problem: stripeProblem,
      secretKey,
      webhookSecret,
      mode,
      livemode: mode === 'live',
      apiBase,
      apiVersion: (env.STRIPE_API_VERSION ?? '').trim() || DEFAULT_STRIPE_API_VERSION,
      checkoutOrigins,
      timeoutMs,
      envTag: (env.STRIPE_ENV_TAG ?? '').trim() || envName,
    },
    turnstile: { siteKey, secretKey: tSecret, verifyUrl, required: isProduction },
    access: { teamDomain, aud, adminEmails, devAdminEmail: envName === 'development' ? devEmail : null },
    bookingsPausedByEnv: (env.BOOKINGS_PAUSED ?? '').trim().toLowerCase() === 'true',
    problems,
  };
}
