/**
 * CSV export hardened against formula injection: any cell starting with = + - @ tab or CR is prefixed
 * with an apostrophe so spreadsheet apps treat it as text.
 */

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: unknown[][]): string {
  // BOM so Excel opens UTF-8 names correctly.
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
