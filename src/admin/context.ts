import type { Deps } from '../shared/booking';
import type { AppConfig, Env } from '../shared/config';
import { type Settings, getSettings } from '../shared/settings';
import type { StripeClient } from '../shared/stripe';

export interface AdminCtx {
  req: Request;
  url: URL;
  env: Env;
  cfg: AppConfig;
  db: D1Database;
  exec: ExecutionContext;
  now: number;
  stripe: StripeClient;
  email: string;
  via: 'access' | 'dev';
  csrf: string;
  form: URLSearchParams | null;
  deps(): Deps;
  settings(): Promise<Settings>;
}

export function makeAdminCtx(init: Omit<AdminCtx, 'deps' | 'settings'>): AdminCtx {
  let settingsP: Promise<Settings> | null = null;
  return {
    ...init,
    deps: () => ({ db: init.db, cfg: init.cfg, stripe: init.stripe, now: init.now }),
    settings: () => (settingsP ??= getSettings(init.db)),
  };
}

export function field(ctx: AdminCtx, name: string): string {
  return (ctx.form?.get(name) ?? '').trim();
}
