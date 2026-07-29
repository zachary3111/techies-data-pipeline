// Read-only: compute the client's asymmetric NFULL-base merged total from the raw
// rows ALREADY stored in the DB (raw_leads), so it works without live Google auth.
// Keeps every NFULL row; omits an MFULL row only if it shares a permalink/post_id/
// phone with an NFULL row; keeps every other MFULL row. No writes, no cost.
//
// Caveat: raw_leads was de-duplicated at ingest on (source, source_record_id) where
// source_record_id = sha256(source|permalink). So NFULL rows that shared a permalink
// were already collapsed here — this can slightly UNDERCOUNT NFULL vs a faithful
// per-sheet-row read (which needs fresh Google tokens via scripts/merge-report.mjs).
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { toCanonical } from '../src/lib/canonical.js';
import { matchKey } from '../src/lib/matchKey.js';
import { mergeAsymmetric } from '../src/lib/mergeAsymmetric.js';

const { rows } = await pool.query(
  `SELECT source::text AS source, raw_payload FROM raw_leads`
);

const bySource = { NFULL: [], MFULL: [] };
for (const r of rows) {
  const canon = toCanonical(r.source, r.raw_payload);
  (bySource[r.source] || (bySource[r.source] = [])).push(canon);
}

const nfull = bySource.NFULL || [];
const mfull = bySource.MFULL || [];
const { counts } = mergeAsymmetric(nfull, mfull);

const nfullKeyed = nfull.filter((r) => matchKey(r)).length;
const mfullKeyed = mfull.filter((r) => matchKey(r)).length;
const okTotal = counts.merged_total === counts.nfull + counts.mfull_only;

console.log('=== Asymmetric NFULL-base merge (from DB raw_leads) ===');
console.log(`NFULL rows (all kept):          ${counts.nfull}`);
console.log(`MFULL rows (total):             ${counts.mfull_total}`);
console.log(`  MFULL omitted (in NFULL):     ${counts.mfull_omitted}`);
console.log(`  MFULL dup collapsed (phone):  ${counts.mfull_dup_collapsed}`);
console.log(`  MFULL-only (kept):            ${counts.mfull_only}`);
console.log(`MERGED TOTAL:                   ${counts.merged_total}`);
console.log(`  check: ${counts.nfull} + ${counts.mfull_only} = ${counts.nfull + counts.mfull_only}  ${okTotal ? '✓' : '✗ MISMATCH'}`);
console.log(`\nFor comparison, the CURRENT (symmetric) pipeline collapses everything to`);
const { rows: mrows } = await pool.query(`SELECT count(*)::int AS c FROM master_leads`);
console.log(`  master_leads (current symmetric unique):  ${mrows[0].c}`);
console.log(`\n(match-key coverage: NFULL ${nfullKeyed}/${counts.nfull}, MFULL ${mfullKeyed}/${counts.mfull_total})`);
console.log('(read-only — no writes, no cost. NFULL may be slightly undercounted — see file header.)');

await pool.end();
process.exitCode = okTotal ? 0 : 1;
