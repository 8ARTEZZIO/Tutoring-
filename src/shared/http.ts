import type { SafeHtml } from './html';

export type Params = Record<string, string>;

interface Route<C> {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: (ctx: C, params: Params) => Promise<Response> | Response;
}

/** Minimal router: '/session/:slug/book' style patterns, exact match, GET also serves HEAD. */
export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: string, pattern: string, handler: Route<C>['handler']): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: Route<C>['handler']): this {
    return this.on('GET', pattern, handler);
  }

  post(pattern: string, handler: Route<C>['handler']): this {
    return this.on('POST', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Route<C>['handler']; params: Params } | 'method' | null {
    const m = method === 'HEAD' ? 'GET' : method;
    let pathMatched = false;
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (route.method !== m) continue;
      const params: Params = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(found[i + 1] ?? '');
        } catch {
          params[k] = '';
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${opts.path ?? '/'}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  /** Private responses: never cached, indexed, or leaked via Referer. */
  private?: boolean;
}

export function privateHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, private, max-age=0',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
  };
}

export function htmlResponse(body: SafeHtml | string, opts: ResponseOptions = {}): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    ...(opts.private ? privateHeaders() : { 'Cache-Control': 'no-cache' }),
    ...(opts.headers ?? {}),
  };
  return new Response('<!doctype html>' + String(body), { status: opts.status ?? 200, headers });
}

export function redirect(location: string, opts: ResponseOptions = {}): Response {
  return new Response(null, {
    status: opts.status ?? 303,
    headers: {
      Location: location,
      ...(opts.private ? privateHeaders() : { 'Cache-Control': 'no-store' }),
      ...(opts.headers ?? {}),
    },
  });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Security headers applied to every response. */
export function applySecurityHeaders(response: Response, csp: string, extra: string[] = []): Response {
  const res = new Response(response.body, response);
  const h = res.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', csp);
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  for (const cookie of extra) h.append('Set-Cookie', cookie);
  return res;
}

/**
 * Same-origin check for state-changing requests. Browsers send Origin on POST; Sec-Fetch-Site is a
 * fallback for older ones. Requests carrying neither are refused.
 */
export function isSameOrigin(req: Request, expectedOrigin: string): boolean {
  const origin = req.headers.get('Origin');
  if (origin) return origin === expectedOrigin;
  const site = req.headers.get('Sec-Fetch-Site');
  return site === 'same-origin';
}

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? '0.0.0.0';
}

export async function readForm(req: Request, maxBytes = 16_384): Promise<URLSearchParams | null> {
  const type = req.headers.get('Content-Type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  return new URLSearchParams(text);
}

export function isBot(req: Request): boolean {
  const ua = (req.headers.get('User-Agent') ?? '').toLowerCase();
  return !ua || /bot|crawler|spider|preview|curl|wget|python-requests|headless|monitor|uptime/.test(ua);
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  // Never pass tokens, emails or full URLs here.
  const line = JSON.stringify({ level, message, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
