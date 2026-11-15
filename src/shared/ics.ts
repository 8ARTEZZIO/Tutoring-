/** RFC 5545 calendar export: one stable UID per lesson, SEQUENCE = lesson revision, UTC times. */

export interface IcsEvent {
  uid: string;
  sequence: number;
  start: number;
  end: number;
  summary: string;
  description: string;
  url?: string;
  location?: string;
  status: 'CONFIRMED' | 'CANCELLED';
}

const encoder = new TextEncoder();

export function icsUtc(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold content lines to at most 75 octets (UTF-8), continuation lines start with a space. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
    if (currentBytes + bytes > limit) {
      out.push(current);
      current = ch;
      currentBytes = bytes;
    } else {
      current += ch;
      currentBytes += bytes;
    }
  }
  out.push(current);
  return out.map((part, i) => (i === 0 ? part : ' ' + part)).join('\r\n');
}

export function buildIcs(opts: { calendarName: string; events: IcsEvent[]; now: number }): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kingston Tutoring//Booking Pilot//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.calendarName)}`,
  ];
  for (const ev of opts.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `SEQUENCE:${ev.sequence}`,
      `DTSTAMP:${icsUtc(opts.now)}`,
      `DTSTART:${icsUtc(ev.start)}`,
      `DTEND:${icsUtc(ev.end)}`,
      `SUMMARY:${icsEscape(ev.summary)}`,
      `DESCRIPTION:${icsEscape(ev.description)}`,
      `STATUS:${ev.status}`,
    );
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
