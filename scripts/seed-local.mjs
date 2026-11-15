#!/usr/bin/env node
// Seeds the LOCAL D1 database with clearly fictional pilot data, dated relative to today.
// Never run against production: it only ever uses `wrangler d1 execute --local`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** UK wall-clock (YYYY-MM-DD, HH:MM) → UTC seconds. Seed times avoid the 01:00–02:00 clock-change hour. */
function ukToUtc(dateKey, time) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  for (const off of [0, 60]) {
    const ts = naive - off * 60;
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
    if (`${p.year}-${p.month}-${p.day}` === dateKey && `${p.hour}:${p.minute}` === time) return ts;
  }
  throw new Error(`cannot convert ${dateKey} ${time}`);
}

function nextWeekday(weekday, minDaysAhead) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const key = (d) => d.toISOString().slice(0, 10);
const plus = (d, days) => new Date(d.getTime() + days * 86400000);
const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const now = Math.floor(Date.now() / 1000);

const listings = [
  {
    id: 'lst_demopilot01', slug: 'python-pilot', kind: 'single', title: 'Python pilot: turning test questions into code', price: 1500,
    summary: 'One 60-minute live session: we work through one exam-style question together, you solve a fresh one under a timer, and you get one written correction.',
    dates: [[key(nextWeekday(2, 3)), '18:00', 60]],
  },
  {
    id: 'lst_demofirst4', slug: 'first-four-session-group', kind: 'package', title: 'First four-session group', price: 8000,
    summary: 'Four fixed weekly sessions. One payment books your seat on all four dates.',
    dates: [0, 7, 14, 21].map((n) => [key(plus(nextWeekday(4, 16), n)), '18:00', 60]),
  },
  {
    id: 'lst_demolater4', slug: 'later-four-session-group', kind: 'package', title: 'Later four-session group', price: 10800,
    summary: 'Four fixed Saturday sessions. One payment books your seat on all four dates.',
    dates: [0, 7, 14, 21].map((n) => [key(plus(nextWeekday(6, 45), n)), '11:00', 60]),
  },
  {
    id: 'lst_demodraft1', slug: 'draft-revision-session', kind: 'single', title: 'Draft: revision session (not published)', price: 1500, status: 'draft',
    summary: 'A draft listing to try the dashboard publish flow.',
    dates: [[key(nextWeekday(1, 30)), '17:00', 90]],
  },
];

const sql = [];
const ids = listings.map((l) => q(l.id)).join(',');
sql.push(`DELETE FROM lesson_changes WHERE listing_id IN (${ids});`);
sql.push(`DELETE FROM lessons WHERE listing_id IN (${ids});`);
sql.push(`DELETE FROM invites WHERE listing_id IN (${ids}) AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.invite_id = invites.id);`);
for (const l of listings) {
  const lessons = l.dates.map(([d, t, mins], i) => {
    const start = ukToUtc(d, t);
    return { id: `les_${l.id.slice(4, 12)}${i + 1}x`, start, end: start + mins * 60, url: `https://meet.example.com/${l.slug}-${i + 1}` };
  });
  const first = Math.min(...lessons.map((x) => x.start));
  const last = Math.max(...lessons.map((x) => x.end));
  sql.push(
    `INSERT INTO listings (id, slug, kind, title, topic, summary, price_pence, capacity, cutoff_minutes, status, first_starts_at, last_ends_at, bookings_close_at, lesson_count, published_at, created_at, updated_at)
     VALUES (${[l.id, l.slug, l.kind, l.title, 'Python test questions', l.summary, l.price, 8, 120, l.status ?? 'published', first, last, first - 7200, lessons.length, l.status === 'draft' ? null : now, now, now].map(q).join(', ')})
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, price_pence = excluded.price_pence, status = excluded.status,
       first_starts_at = excluded.first_starts_at, last_ends_at = excluded.last_ends_at, bookings_close_at = excluded.bookings_close_at,
       lesson_count = excluded.lesson_count, updated_at = excluded.updated_at;`,
  );
  lessons.forEach((x, i) => {
    sql.push(
      `INSERT INTO lessons (id, listing_id, seq, starts_at, ends_at, meeting_url, uid, created_at, updated_at) VALUES (${[x.id, l.id, i + 1, x.start, x.end, x.url, `${x.id}@kingston-tutoring`, now, now].map(q).join(', ')});`,
    );
  });
}
sql.push(
  `INSERT OR IGNORE INTO invites (id, kind, listing_id, code, channel, created_at, created_by) VALUES ('inv_demoqrcode01', 'share', 'lst_demofirst4', 'qr-demo', 'qr', ${now}, 'seed');`,
);
const settings = {
  seller_name: 'Example Tutor (fictional seller for local testing)',
  seller_address: '1 Example Street, Kingston upon Thames (fictional)',
  seller_email: 'tutor@example.com',
};
for (const [k, v] of Object.entries(settings)) {
  sql.push(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (${q(k)}, ${q(v)}, ${now}, 'seed') ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
  );
}

mkdirSync('.wrangler', { recursive: true });
const file = `.wrangler/seed-${randomBytes(4).toString('hex')}.sql`;
writeFileSync(file, sql.join('\n') + '\n');
execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/state', '-c', 'workers/public/wrangler.jsonc', '--file', file, '--yes'],
  { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
);
console.log('\nSeeded fictional local data:');
for (const l of listings) console.log(`  ${l.status === 'draft' ? 'draft    ' : 'published'}  /session/${l.slug}  (${l.dates.map((d) => `${d[0]} ${d[1]}`).join(', ')} UK)`);
console.log('  share link: /i/qr-demo');
