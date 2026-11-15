import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/shared/config';

const base = { DB: {} as D1Database, PUBLIC_ORIGIN: 'https://pub.example', ADMIN_ORIGIN: 'https://adm.example', APP_SECRET: 'x'.repeat(40) };

describe('configuration safety', () => {
  it('treats anything but development/test as production and requires https origins and a real secret', () => {
    expect(loadConfig({ ...base }, 'public').isProduction).toBe(true);
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://pub.example' }, 'public')).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' }, 'public')).toThrow(ConfigError);
  });

  it('keeps live payments under explicit control', () => {
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc' }, 'public').stripe).toMatchObject({ ready: false, mode: 'test' });
    expect(loadConfig({ ...base, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_abc' }, 'public').stripe.ready).toBe(false);
    expect(loadConfig({ ...base, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_abc', ENVIRONMENT: 'development', PUBLIC_ORIGIN: 'http://localhost:8787' }, 'public').stripe.ready).toBe(false);
    expect(loadConfig({ ...base, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_abc' }, 'public').stripe).toMatchObject({ ready: true, livemode: true });
    expect(loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' }, 'public').stripe).toMatchObject({ ready: true, livemode: false });
  });

  it('ignores API base overrides in production', () => {
    const cfg = loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_API_BASE: 'https://evil.example', TURNSTILE_VERIFY_URL: 'https://evil.example' }, 'public');
    expect(cfg.stripe.apiBase).toBe('https://api.stripe.com');
    expect(cfg.stripe.checkoutOrigins).toEqual(['https://checkout.stripe.com']);
    expect(cfg.turnstile.verifyUrl).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(cfg.turnstile.required).toBe(true);
  });

  it('refuses a mock admin identity outside development', () => {
    expect(() => loadConfig({ ...base, DEV_ADMIN_EMAIL: 'me@example.com' }, 'admin')).toThrow(/DEV_ADMIN_EMAIL/);
    expect(() => loadConfig({ ...base, ENVIRONMENT: 'test', DEV_ADMIN_EMAIL: 'me@example.com' }, 'admin')).toThrow(/DEV_ADMIN_EMAIL/);
    const dev = loadConfig({ ...base, ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'Me@Example.com' }, 'admin');
    expect(dev.access.devAdminEmail).toBe('me@example.com');
  });
});
