/** Auto-escaping HTML templates. Interpolated strings are escaped unless wrapped in SafeHtml. */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] ?? ch);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'number') return String(value);
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Trusted markup only (never user input). */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

/** Only http(s) and mailto URLs may be rendered into href attributes. */
export function safeHref(url: string | null | undefined): string {
  if (!url) return '#';
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') return u.toString();
  } catch {
    // fall through
  }
  return '#';
}

/** Render operator-entered plain text as paragraphs (escaped; blank lines split paragraphs). */
export function paragraphs(text: string): SafeHtml {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return html`${blocks.map((b) => {
    if (b.startsWith('## ')) return html`<h2>${b.slice(3)}</h2>`;
    if (b.split('\n').every((line) => line.startsWith('- '))) {
      return html`<ul>${b.split('\n').map((line) => html`<li>${line.slice(2)}</li>`)}</ul>`;
    }
    return html`<p>${b.split('\n').map((line, i) => (i === 0 ? html`${line}` : html`<br>${line}`))}</p>`;
  })}`;
}
