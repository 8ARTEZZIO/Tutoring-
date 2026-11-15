import type { AppConfig } from './config';

/** Server-side Turnstile verification. Fails closed in production when unconfigured. */
export async function verifyTurnstile(
  cfg: AppConfig,
  token: string | null,
  ip: string,
): Promise<{ ok: boolean; reason: string | null }> {
  const { siteKey, secretKey, verifyUrl, required } = cfg.turnstile;
  if (!siteKey || !secretKey) {
    return required ? { ok: false, reason: 'unconfigured' } : { ok: true, reason: null };
  }
  if (!token || token.length > 2048) return { ok: false, reason: 'missing' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip }).toString(),
      signal: controller.signal,
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    return data.success === true ? { ok: true, reason: null } : { ok: false, reason: (data['error-codes'] ?? []).join(',') || 'rejected' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
