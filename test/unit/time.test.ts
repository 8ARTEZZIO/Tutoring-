import { describe, expect, it } from 'vitest';
import { addDaysToKey, fmtSlot, fmtSlotUk, mondayOfKey, ukDateKey, ukLocalToUtc, ukMidnight, ukParts } from '../../src/shared/time';

const ts = (iso: string) => Date.parse(iso) / 1000;

describe('UK time', () => {
  it('converts GMT and BST wall-clock times to UTC', () => {
    expect(ukLocalToUtc('2027-01-12', '18:00')).toMatchObject({ ok: true, ts: ts('2027-01-12T18:00:00Z'), zone: 'GMT' });
    expect(ukLocalToUtc('2027-07-12', '18:00')).toMatchObject({ ok: true, ts: ts('2027-07-12T17:00:00Z'), zone: 'BST' });
  });

  it('rejects times inside the spring-forward gap', () => {
    const r = ukLocalToUtc('2027-03-28', '01:30');
    expect(r).toMatchObject({ ok: false, reason: 'nonexistent' });
    expect(ukLocalToUtc('2027-03-28', '00:59')).toMatchObject({ ok: true, ts: ts('2027-03-28T00:59:00Z') });
    expect(ukLocalToUtc('2027-03-28', '02:00')).toMatchObject({ ok: true, ts: ts('2027-03-28T01:00:00Z') });
  });

  it('asks for the offset during the fall-back repeat and honours the answer', () => {
    const r = ukLocalToUtc('2027-10-31', '01:30');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'ambiguous') {
      expect(r.options.map((o) => o.zone)).toEqual(['BST', 'GMT']);
      expect(r.options.map((o) => o.ts)).toEqual([ts('2027-10-31T00:30:00Z'), ts('2027-10-31T01:30:00Z')]);
    } else throw new Error('expected ambiguous');
    expect(ukLocalToUtc('2027-10-31', '01:30', 60)).toMatchObject({ ok: true, ts: ts('2027-10-31T00:30:00Z') });
    expect(ukLocalToUtc('2027-10-31', '01:30', 0)).toMatchObject({ ok: true, ts: ts('2027-10-31T01:30:00Z') });
  });

  it('rejects malformed input', () => {
    for (const [d, t] of [['2027-02-30', '10:00'], ['2027-13-01', '10:00'], ['2027-01-01', '24:00'], ['tomorrow', '10:00'], ['2027-01-01', '9am']]) {
      expect(ukLocalToUtc(d!, t!)).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('formats slots with the zone that applies on that date', () => {
    expect(fmtSlot(ts('2027-03-25T18:00:00Z'), ts('2027-03-25T19:00:00Z'))).toBe('Thu 25 Mar 2027, 18:00–19:00 GMT');
    expect(fmtSlotUk(ts('2027-04-01T17:00:00Z'), ts('2027-04-01T18:00:00Z'))).toBe('Thu 1 Apr 2027, 18:00–19:00 UK time (BST)');
    // A slot spanning the change shows both zones.
    expect(fmtSlot(ts('2027-03-28T00:30:00Z'), ts('2027-03-28T01:30:00Z'))).toBe('Sun 28 Mar 2027, 00:30 GMT–02:30 BST');
    expect(ukParts(ts('2027-03-28T01:00:00Z')).zone).toBe('BST');
  });

  it('computes UK calendar weeks and midnights', () => {
    expect(mondayOfKey('2027-03-28')).toBe('2027-03-22');
    expect(addDaysToKey('2027-03-22', 7)).toBe('2027-03-29');
    expect(ukMidnight('2027-07-01')).toBe(ts('2027-06-30T23:00:00Z'));
    expect(ukDateKey(ts('2027-06-30T23:30:00Z'))).toBe('2027-07-01');
  });
});
