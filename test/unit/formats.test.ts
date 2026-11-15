import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../src/shared/csv';
import { fmtMoney, isPlaceholderUrl, isValidEmail } from '../../src/shared/format';
import { escapeHtml, html, safeHref } from '../../src/shared/html';
import { buildIcs, foldLine, icsEscape } from '../../src/shared/ics';
import { formEncode, verifyStripeSignature } from '../../src/shared/stripe';

describe('csv', () => {
  it('neutralises spreadsheet formulas and quotes special characters', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 7700')).toBe("'+44 7700");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
    expect(toCsv([['a', 'b']])).toBe('﻿a,b\r\n');
  });
});

describe('html', () => {
  it('escapes interpolated values but not nested templates', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const name = '<script>alert(1)</script>';
    expect(String(html`<p>${name}</p>${html`<b>ok</b>`}`)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><b>ok</b>');
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('https://meet.google.com/x')).toBe('https://meet.google.com/x');
  });
});

describe('ics', () => {
  it('escapes text and folds long lines at 75 octets with CRLF', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const long = 'DESCRIPTION:' + 'é'.repeat(80);
    const folded = foldLine(long);
    for (const line of folded.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true);
    const ics = buildIcs({ calendarName: 'X', now: 0, events: [{ uid: 'u1@x', sequence: 2, start: 1800000000, end: 1800003600, summary: 'S', description: 'D', status: 'CONFIRMED' }] });
    expect(ics).toContain('UID:u1@x\r\nSEQUENCE:2\r\n');
    expect(ics).toContain('DTSTART:20270115T080000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});

describe('stripe helpers', () => {
  it('verifies v1 webhook signatures with tolerance', async () => {
    const secret = 'whsec_unit';
    const body = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 10)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, t)).toBe(true);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 301)).toBe(false);
    expect(await verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, secret, t)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_other', t)).toBe(false);
    expect(await verifyStripeSignature(body, null, secret, t)).toBe(false);
  });

  it('form-encodes nested parameters deterministically', () => {
    expect(formEncode([['metadata[booking_id]', 'bk_1'], ['success_url', 'https://x/r?b=1&session_id={CHECKOUT_SESSION_ID}']])).toBe(
      'metadata%5Bbooking_id%5D=bk_1&success_url=https%3A%2F%2Fx%2Fr%3Fb%3D1%26session_id%3D%7BCHECKOUT_SESSION_ID%7D',
    );
  });
});

describe('format', () => {
  it('formats money and validates inputs', () => {
    expect(fmtMoney(1500)).toBe('£15');
    expect(fmtMoney(10850)).toBe('£108.50');
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isPlaceholderUrl('https://meet.example.com/x')).toBe(true);
    expect(isPlaceholderUrl('https://meet.google.com/x')).toBe(false);
  });
});
