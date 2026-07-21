// Phase 1 verification (no DB, no network, no cost): proves the pure data-contract
// modules behave. Doc Phase 1 completion: one NFULL row and one MFULL row for the
// same lead convert to the same canonical structure / dedup keys.
import assert from 'node:assert/strict';
import { normalizePermalink, extractPostId } from '../src/lib/fburl.js';
import { normalizeUkPhone } from '../src/lib/phone.js';
import { businessKey, fingerprint } from '../src/lib/fingerprint.js';
import { toCanonical, toLeadRow } from '../src/lib/canonical.js';
import { valuesToRows } from '../src/lib/sheets.js';
import { matchKey } from '../src/lib/matchKey.js';
import { mergeAsymmetric } from '../src/lib/mergeAsymmetric.js';
import { csvToObjects } from '../src/lib/csv.js';
import { OUTPUT_HEADERS, toCsv } from '../src/lib/output.js';
import { A_NFULL, A_MFULL, B_NFULL, C_MFULL, D_NFULL, D_MFULL } from './sample-leads.mjs';

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, `FAILED: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('fburl.normalizePermalink');
ok('m.facebook host + fbclid == www.facebook canonical',
  normalizePermalink('https://m.facebook.com/abccafe/posts/1000000000000001') ===
  normalizePermalink('https://www.facebook.com/abccafe/posts/1000000000000001?fbclid=IwAR_abc123'));
ok('invalid url -> null', normalizePermalink('not a url at all') === null);

console.log('fburl.extractPostId');
ok('/posts/{id}', extractPostId('https://www.facebook.com/x/posts/1000000000000001') === '1000000000000001');
ok('story_fbid', extractPostId('https://www.facebook.com/permalink.php?story_fbid=2000000000000002&id=555') === '2000000000000002');
ok('pfbid token preferred', extractPostId('https://www.facebook.com/x/posts/pfbid0ABCdef123') === 'pfbid0ABCdef123');

console.log('phone.normalizeUkPhone (doc duplicate example collapses)');
ok('01234567890 == +44 1234 567890',
  normalizeUkPhone('01234567890') === normalizeUkPhone('+44 1234 567890'));
ok('+44 (0)1234 567890 collapses too',
  normalizeUkPhone('+44 (0)1234 567890') === '+441234567890');
ok('mobile 07123 456789 -> +447123456789', normalizeUkPhone('07123 456789') === '+447123456789');
ok('junk -> null', normalizeUkPhone('N/A') === null);
ok('too short -> null', normalizeUkPhone('12345') === null);

console.log('fingerprint (café vs Cafe Ltd)');
ok('ABC Café == ABC Cafe Ltd', businessKey('ABC Café') === businessKey('ABC Cafe Ltd'));

console.log('canonical: same real-world lead from NFULL and MFULL converges');
const a1 = toCanonical('NFULL', A_NFULL);
const a2 = toCanonical('MFULL', A_MFULL);
ok('same canonical keys/shape', JSON.stringify(Object.keys(a1).sort()) === JSON.stringify(Object.keys(a2).sort()));
ok('same normalized permalink', a1.norm_permalink && a1.norm_permalink === a2.norm_permalink);
ok('same post_id', a1.post_id === '1000000000000001' && a2.post_id === '1000000000000001');
ok('same normalized phone', a1.norm_phone === '+441234567890' && a2.norm_phone === '+441234567890');
ok('same business fingerprint identity', businessKey(a1.business_name) === businessKey(a2.business_name));
ok('per-source id differs (source prefix)', a1.source_record_id !== a2.source_record_id);
ok('MFULL has post_timestamp, NFULL does not', a2.post_timestamp !== null && a1.post_timestamp === null);
ok('raw_payload retained', a1.raw_payload === A_NFULL);

const b = toCanonical('NFULL', B_NFULL);
ok('distinct lead has distinct permalink', b.norm_permalink !== a1.norm_permalink);
ok('fingerprint present for located lead', fingerprint(a1) !== null);

console.log("canonical: MFULL's REAL schema (different names + trailing spaces)");
// Mirrors the actual MFullData.csv header row.
const MFULL_REAL = {
  'Timestamp': '2026-07-12 08:40',
  'Primary Contact ': '01234 567890',
  'Secondary Contact ': '',
  'Company Name  ': 'ABC Cafe Ltd',
  'Business Type': 'Hospitality',
  'Address 1 (Road or Street)  ': '10 High St',
  'Address 2 (Town or City) ': 'Birkenhead',
  'Postal Code ': 'CH41 5LH',
  'Email Address ("." if None)': '.',
  'Lead Proof URL ': 'https://m.facebook.com/abccafe/posts/1000000000000001',
  'Number Found URL ': '',
  'Business Note ': 'Grand opening!',
  'Column 13': ''
};
const mc = toCanonical('MFULL', MFULL_REAL);
ok('business_name mapped despite trailing spaces', mc.business_name === 'ABC Cafe Ltd');
ok('phone mapped from "Primary Contact"', mc.norm_phone === '+441234567890');
ok('postcode mapped from "Postal Code"', mc.postcode === 'CH41 5LH');
ok('message mapped from "Business Note"', mc.message === 'Grand opening!');
ok('proof URL mapped from "Lead Proof URL " (trailing space)', !!mc.norm_permalink);
ok('email "." treated as null', mc.email === null);
ok('MFULL-real converges with NFULL A on permalink', mc.norm_permalink === a1.norm_permalink);
const lr = toLeadRow(mc, MFULL_REAL);
ok('toLeadRow gives validator/display Company Name', lr['Company Name'] === 'ABC Cafe Ltd');
ok('toLeadRow gives Lead Proof URL', !!lr['Lead Proof URL']);
ok('toLeadRow maps Address 2 from MFULL town', lr['Address 2 (Village/Town/City)'] === 'Birkenhead');

console.log('sheets.valuesToRows (direct-Google ingestion)');
// NFULL-style: headers on row 0.
const nfullValues = [
  ['Company Name', 'Lead Proof URL', 'Phone Number'],
  ['ABC Cafe', 'https://facebook.com/x/posts/1', '01234 567890'],
  ['', '', ''] // trailing blank row ignored
];
const nrows = valuesToRows(nfullValues);
ok('NFULL values -> 1 row object', nrows.length === 1);
ok('keyed by header', nrows[0]['Company Name'] === 'ABC Cafe');
// MFULL-style raw export: blank first row, headers on row 1, junk Column 13.
const mfullValues = [
  ['', '', '', ''],
  ['Company Name  ', 'Primary Contact ', 'Lead Proof URL ', 'Column 13'],
  ['MFULL Biz', '0161 496 0000', 'https://facebook.com/y/posts/2', 'junk']
];
const mrows = valuesToRows(mfullValues);
ok('MFULL raw skips blank first row -> 1 row', mrows.length === 1);
ok('MFULL row keyed by real header (trailing space)', mrows[0]['Company Name  '] === 'MFULL Biz');
const mCanon = toCanonical('MFULL', mrows[0]);
ok('MFULL sheet row maps to canonical (name + url + phone)',
  mCanon.business_name === 'MFULL Biz' && !!mCanon.norm_permalink && mCanon.norm_phone === '+441614960000');

console.log('matchKey + mergeAsymmetric (NFULL-base asymmetric dedup)');
const cA_N = toCanonical('NFULL', A_NFULL);
const cA_M = toCanonical('MFULL', A_MFULL);
const cB_N = toCanonical('NFULL', B_NFULL);
const cC_M = toCanonical('MFULL', C_MFULL);
const cD_N = toCanonical('NFULL', D_NFULL);
const cD_M = toCanonical('MFULL', D_MFULL);

ok('matchKey: same phone across sources yields equal key',
  !!matchKey(cA_N) && matchKey(cA_N) === matchKey(cA_M));
ok('matchKey: null when no phone',
  matchKey(toCanonical('NFULL', { 'Company Name': 'No Keys Ltd' })) === null);

// Full rule: NFULL {A,B,D} + MFULL {A(dup of NFULL), C(only), D(only)}
const m1 = mergeAsymmetric([cA_N, cB_N, cD_N], [cA_M, cC_M, cD_M]);
ok('merge: every NFULL row kept', m1.counts.nfull === 3);
ok('merge: MFULL copy that exists in NFULL is omitted (A_MFULL)', m1.counts.mfull_omitted === 1);
ok('merge: omitted row is the MFULL copy', m1.omitted.length === 1 && m1.omitted[0].source === 'MFULL');
ok('merge: MFULL-only rows kept (C, D)', m1.counts.mfull_only === 2);
ok('merge: total = all NFULL + MFULL-only',
  m1.counts.merged_total === 5 && m1.counts.merged_total === m1.counts.nfull + m1.counts.mfull_only);

// NFULL is never deduped against itself — identical NFULL rows both survive.
const m2 = mergeAsymmetric([cA_N, cA_N], []);
ok('merge: NFULL internal duplicate is NOT deduped', m2.counts.merged_total === 2);

// No MFULL self-dedup — duplicate MFULL-only rows both survive.
const m3 = mergeAsymmetric([], [cC_M, cC_M]);
ok('merge: MFULL-only internal duplicate kept (no MFULL self-dedup)',
  m3.counts.mfull_only === 2 && m3.counts.merged_total === 2);

// A keyless MFULL row can't "exist in NFULL" → always kept.
const m4 = mergeAsymmetric([cA_N], [toCanonical('MFULL', { 'Company Name': 'Ghost Ltd' })]);
ok('merge: keyless MFULL row always kept', m4.counts.mfull_only === 1);

console.log('validated output CSV');
const outputCsv = toCsv([{
  ...toLeadRow(cA_N, A_NFULL),
  source: 'NFULL',
  validation_status: 'APPROVED',
  validation_score: 88,
  validation_confidence_pct: 91,
  validation_reasons: ['Strong opening signal', 'Phone, address present'],
  validation_layer: 'ai',
  validated_at: '2026-07-21T12:00:00.000Z',
  master_id: 42,
  exported: false
}]);
const outputRows = csvToObjects(outputCsv);
ok('output exposes validation columns',
  OUTPUT_HEADERS.includes('validation_status') && OUTPUT_HEADERS.includes('validation_score'));
ok('output record round-trips through CSV parser',
  outputRows.length === 1 && outputRows[0].validation_status === 'APPROVED');
ok('validation reasons retain commas without creating columns',
  outputRows[0].validation_reasons === 'Strong opening signal | Phone, address present');
ok('one physical line per output lead', outputCsv.split('\n').length === 2);

console.log(`\nPhase 1 contract: ${passed} checks passed ✅`);

