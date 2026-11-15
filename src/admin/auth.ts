/**
 * Cloudflare Access assertion validation. Access sits in front of the admin hostname, but the Worker
 * does not trust that alone: every request must carry a Cf-Access-Jwt-Assertion signed by the team's
 * keys, issued by the configured team domain, for this application's AUD, unexpired, and for an
 * authorised email. The mock identity exists only for ENVIRONMENT=development on localhost.
 */

import type { AppConfig } from '../shared/config';
import { fromBase64Url, hmacHex, timingSafeEqual } from '../shared/crypto';

export type AuthResult = { ok: true; email: string; via: 'access' | 'dev' } | { ok: false; reason: string };

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const keyCache = new Map<string, { fetchedAt: number; keys: Map<string, CryptoKey> }>();
const KEY_TTL_MS = 10 * 60_000;
const MIN_REFRESH_MS = 60_000;

async function loadKeys(teamDomain: string, force: boolean): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(teamDomain);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  if (cached && (age < KEY_TTL_MS && !force)) return cached.keys;
  if (cached && force && age < MIN_REFRESH_MS) return cached.keys; // rate-limit refreshes on unknown kids
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Access certs request failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of data.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  keyCache.set(teamDomain, { fetchedAt: Date.now(), keys });
  return keys;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(decoder.decode(fromBase64Url(part)));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function verifyAccessJwt(token: string, cfg: AppConfig, nowSec: number): Promise<AuthResult> {
  const fail = (reason: string): AuthResult => ({ ok: false, reason });
  const { teamDomain, aud, adminEmails } = cfg.access;
  if (!teamDomain || !aud || adminEmails.length === 0) return fail('access not configured');
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8192) return fail('malformed');
  const header = decodeJson(parts[0]!);
  const payload = decodeJson(parts[1]!);
  if (!header || !payload) return fail('malformed');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('unsupported algorithm');
  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadKeys(teamDomain, false);
    if (!keys.has(header.kid)) keys = await loadKeys(teamDomain, true);
  } catch {
    return fail('could not load signing keys');
  }
  const key = keys.get(header.kid);
  if (!key) return fail('unknown signing key');
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(parts[2]!);
  } catch {
    return fail('malformed');
  }
  const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) return fail('bad signature');
  if (payload.iss !== teamDomain) return fail('wrong issuer');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return fail('wrong audience');
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return fail('expired');
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return fail('not yet valid');
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) return fail('issued in the future');
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email || !adminEmails.includes(email)) return fail('identity not authorised');
  return { ok: true, email, via: 'access' };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function authenticate(req: Request, url: URL, cfg: AppConfig, nowSec: number): Promise<AuthResult> {
  if (cfg.access.devAdminEmail) {
    // devAdminEmail is only ever non-null when ENVIRONMENT=development (see loadConfig).
    if (cfg.envName === 'development' && LOCAL_HOSTS.has(url.hostname)) {
      return { ok: true, email: cfg.access.devAdminEmail, via: 'dev' };
    }
    return { ok: false, reason: 'mock identity is only valid on localhost' };
  }
  const assertion = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) return { ok: false, reason: 'missing Access assertion' };
  return verifyAccessJwt(assertion, cfg, nowSec);
}

/** CSRF token bound to the operator identity, rotating daily (yesterday's still accepted). */
export async function csrfToken(cfg: AppConfig, email: string, nowSec: number, dayOffset = 0): Promise<string> {
  const day = Math.floor(nowSec / 86_400) - dayOffset;
  return (await hmacHex(cfg.appSecret, `csrf:${email}:${day}`)).slice(0, 40);
}

export async function checkCsrf(cfg: AppConfig, email: string, nowSec: number, value: string | null): Promise<boolean> {
  if (!value) return false;
  for (const offset of [0, 1]) {
    if (timingSafeEqual(value, await csrfToken(cfg, email, nowSec, offset))) return true;
  }
  return false;
}
