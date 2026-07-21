import { EXPECTED_HEADERS } from './canonical.js';

export const OUTPUT_HEADERS = [
  ...EXPECTED_HEADERS,
  'source',
  'validation_status',
  'validation_score',
  'validation_confidence_pct',
  'validation_reasons',
  'validation_layer',
  'validated_at',
  'master_id',
  'exported'
];

function printable(value) {
  if (Array.isArray(value)) return value.join(' | ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value === null || value === undefined ? '' : String(value);
}

function escapeCsv(value) {
  // Keep one physical line per lead so browser CSV readers can process very
  // large exports incrementally without being confused by embedded newlines.
  const text = printable(value).replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(leads) {
  const lines = [OUTPUT_HEADERS.map(escapeCsv).join(',')];
  for (const lead of leads) {
    lines.push(OUTPUT_HEADERS.map((header) => escapeCsv(lead[header])).join(','));
  }
  return lines.join('\n');
}

