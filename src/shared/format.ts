export function fmtMoney(pence: number, currency = 'gbp'): string {
  const symbol = currency.toLowerCase() === 'gbp' ? '£' : `${currency.toUpperCase()} `;
  const pounds = Math.floor(Math.abs(pence) / 100);
  const rest = Math.abs(pence) % 100;
  const sign = pence < 0 ? '-' : '';
  return rest === 0 ? `${sign}${symbol}${pounds}` : `${sign}${symbol}${pounds}.${String(rest).padStart(2, '0')}`;
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(value);
}

export function cleanName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Outreach codes are short, public, non-personal labels used for aggregate counts. */
export function cleanCode(value: string | null | undefined): string {
  const v = (value ?? '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? v : 'direct';
}

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Placeholder hosts that must not be used for real classes. */
export function isPlaceholderUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.test') ||
      host.endsWith('.invalid') ||
      host.endsWith('.example') ||
      host === 'example.com' ||
      host.endsWith('.example.com') ||
      host === 'example.org' ||
      host.endsWith('.example.org') ||
      host === 'example.net'
    );
  } catch {
    return true;
  }
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
