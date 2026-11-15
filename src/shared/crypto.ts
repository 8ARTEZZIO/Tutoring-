/** Small WebCrypto helpers (Workers runtime). */

const encoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 32 random bytes (256 bits), base64url: used for bearer tokens (booking links, invites, device cookies). */
export function randomToken(byteLength = 32): string {
  return toBase64Url(randomBytes(byteLength));
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 symbols: each byte & 31 is unbiased.

/** Opaque, non-secret identifier such as bk_x7k2... (80 bits by default). */
export function randomId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return `${prefix}_${out}`;
}

export function randomCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache.set(secret, key);
  }
  return key;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/** Constant-time comparison for equal-length strings (length itself is not secret here). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Tokens we mint are 43-char base64url strings; reject anything else before touching the database. */
export function looksLikeToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(value);
}
