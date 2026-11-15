/**
 * Operator-editable settings. Defaults live here; rows in the settings table override them.
 * Wording that students agree to (terms incl. cancellation summary, early-start text, privacy) is
 * versioned: every change creates a new version, and each booking records the version it accepted.
 *
 * The default wording is a starting draft for the operator to review — it is not legal advice.
 */

export const DEFAULT_SETTINGS = {
  // Seller details shown before payment. Empty until the operator fills them in (publishing is blocked
  // in production until they are set).
  seller_name: '',
  seller_email: '',
  seller_address: '',
  seller_extra: '',
  tutor_first_name: 'Bartek',
  tutor_intro:
    "I'm Bartek, a Kingston computer science student. I've been helping classmates break down programming questions into steps they can use on their own.",
  bookings_paused: '0',

  terms_version: '2026-11-15.1',
  terms_body: `## Who you're booking with
These classes are independent peer tutoring run by the seller named above. They are not run by, endorsed by or affiliated with Kingston University.

## What you're buying
One booking gives one person a seat on every date listed for that class or package. Classes are live, online, small-group sessions of up to the stated number of students. All dates and times are UK time.

## Price and payment
The price shown before payment is the total you pay. Payment is taken by Stripe; your card details are never seen or stored by this site. Your seat is confirmed only once the payment has been verified.

## Joining
Your private booking page shows your dates and the link to join each session. Please join on time with a laptop and a way to run Python.

## Cancelling and refunds
See the cancellation information below. To cancel, use "Request cancellation" on your private booking page or email the contact address.

## Changes
If a session has to move, you'll be told as soon as possible with the new time and an updated calendar file. If you can't make the new time you can ask for a refund for that session.

## Contact
Email the contact address above. Replies normally within two working days.`,
  cancellation_summary:
    "You can cancel within 14 days of booking for a full refund. If your class starts within those 14 days, you'll be asked to request an early start: you can still cancel for a full refund before it starts, but once a class has been fully provided the right to cancel ends, and if you cancel a package after it has started you'll be refunded for the sessions not yet provided. If a date moves and you can't make the new time, or a class is cancelled, you'll get a full refund for the affected sessions. Refunds go back to the card you paid with.",

  early_start_version: '2026-11-15.1',
  early_start_request_text: 'I ask for my booking to start within the 14-day cancellation period.',
  early_start_ack_text:
    "I understand that if I cancel after a session has started I'll pay for what has been provided, and that I lose my right to cancel once the booking has been fully provided.",

  privacy_version: '2026-11-15.1',
  privacy_body: `## Who is responsible for your data
The seller named above is responsible for the information collected through this booking site.

## What is collected and why
- Your first name and email address, to make and manage your booking and contact you about it (needed to provide the booking).
- Which class you booked, the price, your cancellation-period choices and the version of the terms you accepted (needed for the booking and for records).
- Payment status and references from Stripe. Card details are handled by Stripe and never reach this site.
- If you join a waitlist: your email, optional first name and preferred days, so you can be told when a seat opens (your request).
- If you tick the weekly practice question box: your email, to send it until you unsubscribe (your consent).
- Aggregate visit counts per outreach link, without cookies or personal data.

## Cookies
Only strictly necessary cookies: one keeps your booking available on the device you used, and one remembers which invitation link you followed. No advertising or tracking cookies.

## Who it is shared with
Stripe (payments), Cloudflare (hosting and spam protection) and the email provider used to contact you. Your data is never sold.

## How long it is kept
Paid booking records are kept as long as needed for tax and accounting (normally six years). Unfinished checkouts are anonymised after {{retention_unpaid_days}} days. Waitlist and interest entries are deleted after {{retention_leads_days}} days or when you leave the list.

## Your rights
You can ask for a copy of your data, ask for it to be corrected or deleted, object to its use, or withdraw consent at any time by emailing the contact address. You can also complain to the Information Commissioner's Office (ico.org.uk).`,
  retention_leads_days: '180',
  retention_unpaid_days: '30',

  what_to_bring: 'A laptop with Python 3 installed (or a browser-based Python editor), and one test question you found hard.',
  how_to_join:
    "Your private booking page shows the call link for each session once your payment is confirmed. Bartek's confirmation email includes the link to that page.",

  tpl_confirmation_subject: "You're booked: {{listing_title}}",
  tpl_confirmation_body: `Hi {{first_name}},

Thanks for booking {{listing_title}}. Your seat is confirmed.

Dates (UK time):
{{dates}}

Total paid: {{price}} (one payment covers one seat on all the dates above)
Booking reference: {{booking_id}}

Your private booking page (dates, join links and calendar file):
{{booking_link}}
Keep this link private: it opens your booking without a password.

Cancellation: {{cancellation_info}}

See you there,
{{seller_name}}
{{contact_email}}
Independent peer tutoring, not affiliated with Kingston University.`,
  tpl_reminder_subject: 'Reminder: {{listing_title}}, {{next_date}}',
  tpl_reminder_body: `Hi all,

A quick reminder that {{listing_title}} is on {{next_date}}.

The join link is on your private booking page (use the link from your confirmation email). If you've lost it, just reply to this email.

Please bring: {{what_to_bring}}

See you soon,
{{seller_name}}`,
  tpl_datechange_subject: 'Date change: {{listing_title}}',
  tpl_datechange_body: `Hi all,

A date for {{listing_title}} has changed:
{{changes}}

Updated schedule (UK time):
{{dates}}

Your private booking page always shows the current schedule, and you can download an updated calendar file there (it replaces the old events). If you can't make the new time, reply to this email and you'll get a refund for that session.

Sorry for any inconvenience,
{{seller_name}}`,
  tpl_refund_subject: 'Refund for {{listing_title}}',
  tpl_refund_body: `Hi {{first_name}},

I've refunded {{refund_amount}} for {{listing_title}} (booking {{booking_id}}). It goes back to the card you paid with and usually arrives within 5 to 10 working days.

{{seller_name}}`,
  tpl_cancelled_subject: 'Cancelled: {{listing_title}}',
  tpl_cancelled_body: `Hi all,

I'm sorry: {{listing_title}} has been cancelled. {{cancel_reason}}

You'll get a full refund for any sessions that haven't taken place, back to the card you paid with. You don't need to do anything.

Other dates: {{calendar_link}}

{{seller_name}}`,
  tpl_waitlist_subject: 'A seat is open: {{listing_title}}',
  tpl_waitlist_body: `Hi,

You asked to hear when a seat opened on {{listing_title}}.

{{dates}}

Book here (first come, first served): {{booking_link}}

You're getting this because you joined the waitlist. Reply "leave" and you'll be removed.

{{seller_name}}`,
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = Record<SettingKey, string>;

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** Keys whose change creates a new policy version. */
export const VERSIONED: Record<string, { versionKey: SettingKey; kind: string; parts: SettingKey[] }> = {
  terms: { versionKey: 'terms_version', kind: 'terms', parts: ['terms_body', 'cancellation_summary'] },
  early_start: {
    versionKey: 'early_start_version',
    kind: 'early_start',
    parts: ['early_start_request_text', 'early_start_ack_text'],
  },
  privacy: { versionKey: 'privacy_version', kind: 'privacy', parts: ['privacy_body'] },
};

/**
 * Read settings fresh on every request (memoised per request by the callers). Deliberately not cached
 * across requests: the public and admin Workers run in different isolates, and a pause or wording
 * change must apply immediately.
 */
export async function getSettings(db: D1Database): Promise<Settings> {
  const res = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const value: Settings = { ...DEFAULT_SETTINGS };
  for (const row of res.results) {
    if (row.key in DEFAULT_SETTINGS) value[row.key as SettingKey] = row.value;
  }
  return value;
}

function nextVersion(current: string, now: number): string {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(current);
  if (m && m[1] === day) return `${day}.${Number(m[2]) + 1}`;
  return `${day}.1`;
}

/** Save a patch; bumps policy versions when agreed wording changes. Returns the keys that changed. */
export async function saveSettings(
  db: D1Database,
  patch: Partial<Settings>,
  actor: string,
  now: number,
): Promise<string[]> {
  const current = await getSettings(db);
  const changed: string[] = [];
  const next: Settings = { ...current };
  for (const key of SETTING_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key.endsWith('_version')) continue; // versions are managed here, never edited directly
    const normalised = value.replace(/\r\n/g, '\n');
    if (normalised !== current[key]) {
      next[key] = normalised;
      changed.push(key);
    }
  }
  const statements: D1PreparedStatement[] = [];
  for (const spec of Object.values(VERSIONED)) {
    if (spec.parts.some((p) => changed.includes(p))) {
      next[spec.versionKey] = nextVersion(current[spec.versionKey], now);
      changed.push(spec.versionKey);
      statements.push(
        db
          .prepare('INSERT OR REPLACE INTO policy_versions (kind, version, body, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
          .bind(spec.kind, next[spec.versionKey], spec.parts.map((p) => next[p]).join('\n\n---\n\n'), now, actor),
      );
    }
  }
  for (const key of changed) {
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .bind(key, next[key as SettingKey], now, actor),
    );
  }
  if (statements.length) await db.batch(statements);
  return changed;
}

export function sellerReady(s: Settings): boolean {
  return Boolean(s.seller_name.trim() && s.seller_email.trim() && s.seller_address.trim());
}

/** {{placeholder}} substitution for templates and policy text. Unknown placeholders are left visible. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) => (key in values ? values[key]! : match));
}
