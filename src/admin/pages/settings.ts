import { audit } from '../../shared/db';
import { type SafeHtml, html } from '../../shared/html';
import { DEFAULT_SETTINGS, type SettingKey, type Settings, saveSettings } from '../../shared/settings';
import type { AdminCtx } from '../context';
import { adminLayout, back, csrfField } from '../ui';

interface FieldSpec {
  key: SettingKey;
  label: string;
  hint?: string;
  area?: 'short' | 'tall';
}

const GROUPS: { title: string; note?: string; fields: FieldSpec[] }[] = [
  {
    title: 'Seller details (shown before payment)',
    note: 'UK online selling rules require your name, a geographic address and an email address before payment.',
    fields: [
      { key: 'seller_name', label: 'Seller (your legal name or business name)' },
      { key: 'seller_address', label: 'Geographic address', hint: 'a real postal address' },
      { key: 'seller_email', label: 'Contact email' },
      { key: 'seller_extra', label: 'Extra seller info', hint: 'optional, e.g. "Sole trader"' },
      { key: 'tutor_first_name', label: 'Tutor first name (used on the home page)' },
      { key: 'tutor_intro', label: 'About the tutor', area: 'short' },
    ],
  },
  {
    title: 'Booking terms and cancellation (versioned)',
    note: 'Changing either text creates a new terms version; each booking records the version accepted. Please review this wording yourself; it is a starting draft, not legal advice.',
    fields: [
      { key: 'cancellation_summary', label: 'Cancellation information shown before payment', area: 'short' },
      { key: 'terms_body', label: 'Booking terms', hint: 'blank lines separate paragraphs; "## " starts a heading', area: 'tall' },
    ],
  },
  {
    title: 'Starting within 14 days (versioned)',
    note: 'Shown as two required checkboxes when the first date is within the 14-day cancellation period.',
    fields: [
      { key: 'early_start_request_text', label: 'Express request to start early', area: 'short' },
      { key: 'early_start_ack_text', label: 'Acknowledgement', area: 'short' },
    ],
  },
  {
    title: 'Privacy and retention (versioned)',
    fields: [
      { key: 'privacy_body', label: 'Privacy notice', hint: '{{retention_leads_days}} and {{retention_unpaid_days}} are filled in', area: 'tall' },
      { key: 'retention_leads_days', label: 'Delete waitlist/interest entries after (days)' },
      { key: 'retention_unpaid_days', label: 'Anonymise unpaid checkout attempts after (days)' },
    ],
  },
  {
    title: 'FAQ text',
    fields: [
      { key: 'what_to_bring', label: 'What to bring', area: 'short' },
      { key: 'how_to_join', label: 'How to join', area: 'short' },
    ],
  },
  {
    title: 'Email templates',
    note: 'Placeholders: {{first_name}} {{listing_title}} {{dates}} {{price}} {{booking_id}} {{booking_link}} {{cancellation_info}} {{next_date}} {{what_to_bring}} {{changes}} {{refund_amount}} {{cancel_reason}} {{calendar_link}} {{seller_name}} {{contact_email}}',
    fields: [
      { key: 'tpl_confirmation_subject', label: 'Confirmation subject' },
      { key: 'tpl_confirmation_body', label: 'Confirmation body', area: 'tall' },
      { key: 'tpl_reminder_subject', label: 'Reminder subject' },
      { key: 'tpl_reminder_body', label: 'Reminder body', area: 'tall' },
      { key: 'tpl_datechange_subject', label: 'Date change subject' },
      { key: 'tpl_datechange_body', label: 'Date change body', area: 'tall' },
      { key: 'tpl_refund_subject', label: 'Refund subject' },
      { key: 'tpl_refund_body', label: 'Refund body', area: 'tall' },
      { key: 'tpl_cancelled_subject', label: 'Cancellation subject' },
      { key: 'tpl_cancelled_body', label: 'Cancellation body', area: 'tall' },
      { key: 'tpl_waitlist_subject', label: 'Seat alert subject' },
      { key: 'tpl_waitlist_body', label: 'Seat alert body', area: 'tall' },
    ],
  },
];

function input(f: FieldSpec, s: Settings): SafeHtml {
  const id = `s_${f.key}`;
  const label = html`<label for="${id}">${f.label}${f.hint ? html` <span class="hint">${f.hint}</span>` : ''}</label>`;
  if (f.area) {
    return html`<div class="f">${label}<textarea id="${id}" name="${f.key}" class="${f.area === 'tall' ? 'tall' : ''}">${s[f.key]}</textarea></div>`;
  }
  return html`<div class="f">${label}<input id="${id}" name="${f.key}" type="text" value="${s[f.key]}"></div>`;
}

export async function renderSettings(ctx: AdminCtx): Promise<Response> {
  const s = await ctx.settings();
  const versions = await ctx.db
    .prepare('SELECT kind, version, created_at, created_by FROM policy_versions ORDER BY created_at DESC LIMIT 20')
    .all<{ kind: string; version: string; created_at: number; created_by: string }>();
  const body = html`<h1>Settings</h1>
    <p class="small muted">Current versions: terms ${s.terms_version} · early start ${s.early_start_version} · privacy ${s.privacy_version}${versions.results.length ? ` · ${versions.results.length} earlier version(s) archived` : ''}.</p>
    <form method="post" action="/settings">${csrfField(ctx)}
      ${GROUPS.map((g) => html`<div class="card"><h2>${g.title}</h2>${g.note ? html`<p class="small muted">${g.note}</p>` : ''}${g.fields.map((f) => input(f, s))}</div>`)}
      <button class="primary" type="submit">Save settings</button>
    </form>`;
  return adminLayout(ctx, { title: 'Settings', body });
}

export async function handleSaveSettings(ctx: AdminCtx): Promise<Response> {
  const patch: Partial<Settings> = {};
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const value = ctx.form?.get(f.key);
      if (value !== null && value !== undefined) patch[f.key] = value.slice(0, 20_000);
    }
  }
  for (const key of ['retention_leads_days', 'retention_unpaid_days'] as const) {
    if (patch[key] !== undefined && !/^\d{1,4}$/.test(patch[key]!.trim())) patch[key] = DEFAULT_SETTINGS[key];
    if (patch[key] !== undefined) patch[key] = patch[key]!.trim();
  }
  if (patch.seller_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.seller_email.trim())) {
    return back('/settings', { err: 'Contact email does not look valid.' });
  }
  const changed = await saveSettings(ctx.db, patch, ctx.email, ctx.now);
  await audit(ctx.db, ctx.email, 'settings_saved', null, null, { changed }, ctx.now);
  const versions = changed.filter((k) => k.endsWith('_version'));
  return back('/settings', { ok: changed.length ? `Saved ${changed.length} change(s).${versions.length ? ` New version(s): ${versions.join(', ')}.` : ''}` : 'No changes.' });
}
