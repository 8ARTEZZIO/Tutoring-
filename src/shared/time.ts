/**
 * UK time handling. Storage is always UTC unix seconds; everything shown to people is Europe/London.
 * Formatting is composed from numeric parts so output is identical across ICU versions.
 */

export const UK_TZ = 'Europe/London';

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: UK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface UkParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
  offsetMinutes: number;
  zone: 'GMT' | 'BST' | string;
}

export function zoneLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'GMT';
  if (offsetMinutes === 60) return 'BST';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function ukParts(ts: number): UkParts {
  const parts = partsFormatter.formatToParts(new Date(ts * 1000));
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = num('year');
  const month = num('month');
  const day = num('day');
  const hour = num('hour') % 24;
  const minute = num('minute');
  const second = num('second');
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  const offsetMinutes = Math.round((localAsUtc - Math.floor(ts)) / 60);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return { year, month, day, hour, minute, second, weekday, offsetMinutes, zone: zoneLabel(offsetMinutes) };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function fmtTime(ts: number): string {
  const p = ukParts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Tue 24 Nov" */
export function fmtDateShort(ts: number): string {
  const p = ukParts(ts);
  return `${WEEKDAYS_SHORT[p.weekday]} ${p.day} ${MONTHS_SHORT[p.month - 1]}`;
}

/** "Tue 24 Nov 2026" */
export function fmtDate(ts: number): string {
  const p = ukParts(ts);
  return `${WEEKDAYS_SHORT[p.weekday]} ${p.day} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** "Tuesday 24 November 2026" */
export function fmtDateLong(ts: number): string {
  const p = ukParts(ts);
  return `${WEEKDAYS_LONG[p.weekday]} ${p.day} ${MONTHS_LONG[p.month - 1]} ${p.year}`;
}

/** "18:00–19:00 GMT" (both zones shown if a slot crosses a clock change). */
export function fmtTimeRange(start: number, end: number): string {
  const a = ukParts(start);
  const b = ukParts(end);
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
  const endText = sameDay ? `${pad(b.hour)}:${pad(b.minute)}` : `${fmtDateShort(end)} ${pad(b.hour)}:${pad(b.minute)}`;
  if (a.offsetMinutes !== b.offsetMinutes) {
    return `${pad(a.hour)}:${pad(a.minute)} ${a.zone}–${endText} ${b.zone}`;
  }
  return `${pad(a.hour)}:${pad(a.minute)}–${endText} ${a.zone}`;
}

/** "Tue 24 Nov 2026, 18:00–19:00 GMT" — the one canonical slot string used everywhere. */
export function fmtSlot(start: number, end: number): string {
  return `${fmtDate(start)}, ${fmtTimeRange(start, end)}`;
}

/** "Tue 24 Nov 2026, 18:00–19:00 UK time (GMT)" */
export function fmtSlotUk(start: number, end: number): string {
  const a = ukParts(start);
  const b = ukParts(end);
  const range = fmtTimeRange(start, end);
  if (a.offsetMinutes !== b.offsetMinutes) return `${fmtDate(start)}, ${range} (UK time)`;
  return `${fmtDate(start)}, ${range.replace(/ (GMT|BST|UTC[^ ]*)$/, '')} UK time (${a.zone})`;
}

export function fmtDuration(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? '60 minutes' : `${minutes / 60} hours`;
  if (minutes < 60) return `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---- Local (UK) wall-clock → UTC ----------------------------------------------------------------

export type LocalConversion =
  | { ok: true; ts: number; offsetMinutes: number; zone: string }
  | { ok: false; reason: 'invalid'; message: string }
  | { ok: false; reason: 'nonexistent'; message: string }
  | { ok: false; reason: 'ambiguous'; message: string; options: { ts: number; offsetMinutes: number; zone: string }[] };

export function parseDateKey(key: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { y, m, d };
}

export function parseTime(value: string): { hh: number; mm: number } | null {
  const match = /^(\d{2}):(\d{2})(?::00)?$/.exec(value);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/**
 * Convert a UK wall-clock date/time to UTC.
 * - Spring-forward gap (e.g. 01:30 on the last Sunday of March) → 'nonexistent'.
 * - Fall-back repeat (e.g. 01:30 on the last Sunday of October) → 'ambiguous' unless the caller
 *   states the intended offset (60 = BST, the first 01:30; 0 = GMT, the second 01:30).
 */
export function ukLocalToUtc(date: string, time: string, chosenOffsetMinutes?: number): LocalConversion {
  const dk = parseDateKey(date);
  const tm = parseTime(time);
  if (!dk || !tm) return { ok: false, reason: 'invalid', message: 'Enter a valid date (YYYY-MM-DD) and time (HH:MM).' };
  const naive = Date.UTC(dk.y, dk.m - 1, dk.d, tm.hh, tm.mm) / 1000;
  const offsets = new Set([
    ukParts(naive - 86_400).offsetMinutes,
    ukParts(naive).offsetMinutes,
    ukParts(naive + 86_400).offsetMinutes,
  ]);
  const candidates: { ts: number; offsetMinutes: number; zone: string }[] = [];
  for (const off of offsets) {
    const ts = naive - off * 60;
    const p = ukParts(ts);
    if (p.year === dk.y && p.month === dk.m && p.day === dk.d && p.hour === tm.hh && p.minute === tm.mm) {
      if (!candidates.some((c) => c.ts === ts)) candidates.push({ ts, offsetMinutes: off, zone: zoneLabel(off) });
    }
  }
  candidates.sort((a, b) => a.ts - b.ts);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'nonexistent',
      message: `${time} on ${date} does not exist in the UK: the clocks go forward that night. Choose a different time.`,
    };
  }
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return { ok: true, ts: c.ts, offsetMinutes: c.offsetMinutes, zone: c.zone };
  }
  if (chosenOffsetMinutes !== undefined) {
    const c = candidates.find((x) => x.offsetMinutes === chosenOffsetMinutes);
    if (c) return { ok: true, ts: c.ts, offsetMinutes: c.offsetMinutes, zone: c.zone };
  }
  return {
    ok: false,
    reason: 'ambiguous',
    message: `${time} on ${date} happens twice in the UK because the clocks go back that night. Choose which one you mean.`,
    options: candidates,
  };
}

// ---- Calendar helpers ---------------------------------------------------------------------------

export function ukDateKey(ts: number): string {
  const p = ukParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDaysToKey(key: string, days: number): string {
  const dk = parseDateKey(key);
  if (!dk) return key;
  const d = new Date(Date.UTC(dk.y, dk.m - 1, dk.d + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function weekdayOfKey(key: string): number {
  const dk = parseDateKey(key);
  if (!dk) return 0;
  return (new Date(Date.UTC(dk.y, dk.m - 1, dk.d)).getUTCDay() + 6) % 7;
}

export function mondayOfKey(key: string): string {
  return addDaysToKey(key, -weekdayOfKey(key));
}

/** UTC timestamp of 00:00 UK time on the given date (midnight is never inside a UK clock change). */
export function ukMidnight(key: string): number {
  const r = ukLocalToUtc(key, '00:00');
  if (r.ok) return r.ts;
  const dk = parseDateKey(key);
  return dk ? Date.UTC(dk.y, dk.m - 1, dk.d) / 1000 : 0;
}

export function fmtDayHeading(key: string): string {
  const dk = parseDateKey(key);
  if (!dk) return key;
  return `${WEEKDAYS_LONG[weekdayOfKey(key)]} ${dk.d} ${MONTHS_LONG[dk.m - 1]}`;
}

export function fmtWeekLabel(mondayKey: string): string {
  const start = parseDateKey(mondayKey);
  const endKey = addDaysToKey(mondayKey, 6);
  const end = parseDateKey(endKey);
  if (!start || !end) return mondayKey;
  const s = `${start.d} ${MONTHS_SHORT[start.m - 1]}`;
  const e = `${end.d} ${MONTHS_SHORT[end.m - 1]} ${end.y}`;
  return `${s} – ${e}`;
}

/** Values for <input type=date> / <input type=time> in UK local time. */
export function toDateInput(ts: number): string {
  return ukDateKey(ts);
}

export function toTimeInput(ts: number): string {
  return fmtTime(ts);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
