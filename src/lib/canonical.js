// The data contract. Converts a raw source row into one canonical lead shape.
// Pure, no I/O. NFULL and MFULL use DIFFERENT source-sheet column names (e.g.
// NFULL 'Phone Number' vs MFULL 'Primary Contact', NFULL 'Lead Statement' vs
// MFULL 'Business Note'), sometimes with trailing spaces — so lookups are
// trimmed + case-insensitive and every field has aliases for both schemas.

import { createHash } from 'node:crypto';
import { normalizePermalink, extractPostId } from './fburl.js';
import { firstUkPhone } from './phone.js';

// Legacy exact header constants (kept for reference/back-compat).
export const H = {
  TIMESTAMP: 'Timestamp',
  COMPANY: 'Company Name',
  PHONE: 'Phone Number',
  PROOF_URL: 'Lead Proof URL',
  STATEMENT: 'Lead Statement',
  POSTCODE: 'Post Code (Please Put The Full Postcode, Example: CH41 5LH)',
  ADDR1: 'Address 1 (Road/Street/Lane/Park/Industrial Estate)',
  ADDR2: 'Address 2 (Village/Town/City)',
  PHONE2: 'Phone 2'
};

// The 9 display columns both frontends render (NFULL's vocabulary / order).
export const EXPECTED_HEADERS = [
  'Lead Statement',
  'Timestamp',
  'Company Name',
  'Industry Type',
  'Email',
  'Phone Number',
  'Address 1 (Road/Street/Lane/Park/Industrial Estate)',
  'Address 2 (Village/Town/City)',
  'Phone 2',
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)',
  'Lead Proof URL'
];

// Field aliases: NFULL verbose names + MFULL sheet names. Matched trimmed+lower.
const ALIASES = {
  timestamp: ['Timestamp'],
  business_name: ['Company Name'],
  phone: ['Phone Number', 'Primary Contact'],
  phone2: ['Phone 2', 'Secondary Contact'],
  phone3: ['Phone 3'],
  url: ['Lead Proof URL'],
  message: ['Lead Statement', 'Business Note'],
  postcode: ['Post Code (Please Put The Full Postcode, Example: CH41 5LH)', 'Post Code', 'Postal Code'],
  town: ['Address 2 (Village/Town/City)', 'Address 2 (Town or City)', 'Address 2'],
  address1: ['Address 1 (Road/Street/Lane/Park/Industrial Estate)', 'Address 1 (Road or Street)', 'Address 1'],
  county: ['County'],
  email: ['Email Address ("." if None)', 'Email Address', 'Email'],
  industry: ['Industry Type', 'Business Type'],
  old_address: ['Old Address? (For relocation, new branch, and moving premises only with no given address)', 'Old Address'],
  posting_date: ['Lead Posting Date']
};

function buildLookup(row) {
  const m = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (k == null) continue;
    m[String(k).trim().toLowerCase()] = v;
  }
  return m;
}

function get(lookup, field) {
  for (const name of ALIASES[field] || []) {
    const v = lookup[name.trim().toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// MFULL stores "." for "no email".
function cleanEmail(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s === '' || s === '.' ? null : s;
}

function toIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function sourceRecordId(source, row, normPermalink) {
  if (normPermalink) return sha256(`${source}|${normPermalink}`);
  const values = Object.keys(row).sort().map((k) => `${k}=${row[k]}`).join('');
  return sha256(`${source}|${values}`);
}

/** Map any source row (NFULL or MFULL vocabulary) to the canonical lead. */
export function toCanonical(source, row) {
  const lookup = buildLookup(row);
  const url = get(lookup, 'url');
  const norm_permalink = normalizePermalink(url);
  const post_id = extractPostId(url);
  const norm_phone = firstUkPhone(get(lookup, 'phone'), get(lookup, 'phone2'), get(lookup, 'phone3'));

  const town = get(lookup, 'town');
  const county = get(lookup, 'county');
  const location = [town, county].filter(Boolean).join(', ') || null;

  const source_record_id = sourceRecordId(source, row, norm_permalink);
  // Cross-source identity is deliberately phone-only. Facebook permalinks and
  // post IDs identify posts, not businesses, so the same phone across different
  // posts must converge. Rows without a usable UK phone remain unique.
  const dedup_key = norm_phone ? `phone:${norm_phone}` : `rid:${source_record_id}`;

  return {
    source,
    source_record_id,
    dedup_key,
    post_id,
    url,
    owner_name: null,
    message: get(lookup, 'message'),
    post_timestamp: toIso(get(lookup, 'posting_date')),
    scrape_timestamp: toIso(get(lookup, 'timestamp')),
    business_name: get(lookup, 'business_name'),
    industry: get(lookup, 'industry'),
    phone: get(lookup, 'phone') || get(lookup, 'phone2'),
    phone2: get(lookup, 'phone2'),
    email: cleanEmail(get(lookup, 'email')),
    postcode: get(lookup, 'postcode'),
    address1: get(lookup, 'address1'),
    location,
    norm_permalink,
    norm_phone,
    raw_payload: row
  };
}

/**
 * Build a lead row in the verbose header vocabulary the validator and both
 * frontends expect, populated from the canonical master (schema-agnostic) plus
 * the merged raw payload for fields the master doesn't retain (address1, phone2,
 * industry, county, old address). Works uniformly for NFULL and MFULL leads.
 */
export function toLeadRow(master, mergedPayload = {}) {
  const lookup = buildLookup(mergedPayload);
  return {
    'Lead Statement': master.message || get(lookup, 'message') || '',
    'Timestamp': master.scrape_timestamp || get(lookup, 'timestamp') || '',
    'Company Name': master.business_name || get(lookup, 'business_name') || '',
    'Phone Number': master.phone || '',
    'Phone 2': master.phone2 || get(lookup, 'phone2') || '',
    'Industry Type': master.industry || get(lookup, 'industry') || '',
    'Address 1 (Road/Street/Lane/Park/Industrial Estate)': master.address1 || get(lookup, 'address1') || '',
    'Address 2 (Village/Town/City)': get(lookup, 'town') || master.location || '',
    'County': get(lookup, 'county') || '',
    'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': master.postcode || '',
    'Lead Proof URL': master.url || '',
    'Lead Posting Date': master.post_timestamp || '',
    'Old Address? (For relocation, new branch, and moving premises only with no given address)': get(lookup, 'old_address') || '',
    'Email': master.email || ''
  };
}
