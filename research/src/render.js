'use strict';

const num = (value, digits) => Number(value).toLocaleString('de-DE', {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});

/** 0.0123 -> "+1,2 %"; null -> "–". */
function pct(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const text = num(Math.abs(value) * 100, digits);
  // Aus -0,04 % wird gerundet "0,0 %" – dann kein Vorzeichen.
  const zero = Number(text.replace(',', '.')) === 0;
  return `${zero ? '' : value > 0 ? '+' : '−'}${text} %`;
}

/** Anteil ohne Vorzeichen: 0.54 -> "54 %". */
function share(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return `${num(value * 100, 0)} %`;
}

function fixed(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  return num(value, digits).replace('-', '−');
}

/**
 * Textausgabe als Markdown-Tabelle; im Terminal ebenso lesbar wie in einer .md-Datei.
 * Spalten, die nur Zahlen enthalten, stehen rechtsbündig, alle anderen linksbündig.
 */
function table(headers, rows) {
  const cells = [headers, ...rows].map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((_, col) => Math.max(3, ...cells.map((row) => row[col].length)));
  const numeric = headers.map((_, col) => col > 0 && rows.every((row) => /^(–|[+−-]?[\d.,]+( %)?)$/.test(String(row[col]))));
  const line = (row) => `| ${row.map((cell, col) => (numeric[col] ? cell.padStart(widths[col]) : cell.padEnd(widths[col]))).join(' | ')} |`;
  const separator = `| ${widths.map((w, col) => (numeric[col] ? `${'-'.repeat(w - 1)}:` : `:${'-'.repeat(w - 1)}`)).join(' | ')} |`;
  return [line(cells[0]), separator, ...cells.slice(1).map(line)].join('\n');
}

/**
 * CSV für Excel mit deutschen Einstellungen: Semikolon als Trenner,
 * Dezimalkomma, UTF-8 mit BOM.
 */
function toCsv(columns, records) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(';'), ...records.map((record) => columns.map((column) => escape(record[column])).join(';'))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { pct, share, fixed, table, toCsv };
