// Read-only: compute the client's asymmetric NFULL-base merged total on the REAL
// sheets, using the SAME Google read + canonical mapping the pipeline uses.
// Keeps every NFULL row; omits an MFULL row only if it shares a permalink/post_id/
// phone with an NFULL row; keeps every other MFULL row. No DB, no writes, no cost.
import 'dotenv/config';
import { sourceConfigs, readSheetRows } from '../src/lib/sheets.js';
import { toCanonical } from '../src/lib/canonical.js';
import { matchKey } from '../src/lib/matchKey.js';
import { mergeAsymmetric } from '../src/lib/mergeAsymmetric.js';

const cfgs = sourceConfigs();
if (!cfgs.length) {
  console.error('No sources configured (need NFULL_/MFULL_SPREADSHEET_ID + token env).');
  process.exit(1);
}

const bySource = { NFULL: [], MFULL: [] };
for (const cfg of cfgs) {
  try {
    const rows = await readSheetRows(cfg);
    bySource[cfg.name] = rows.map((r) => toCanonical(cfg.name, r));
    console.log(`  ✓ ${cfg.name}: read ${rows.length} rows from Google`);
  } catch (err) {
    console.log(`  ❌ ${cfg.name}: ${err.message}`);
  }
}

const nfull = bySource.NFULL || [];
const mfull = bySource.MFULL || [];
const { counts } = mergeAsymmetric(nfull, mfull);

// How many rows even HAVE a match-key (rows without one are always kept).
const nfullKeyed = nfull.filter((r) => matchKey(r)).length;
const mfullKeyed = mfull.filter((r) => matchKey(r)).length;

const okTotal = counts.merged_total === counts.nfull + counts.mfull_only;

console.log('\n=== Asymmetric NFULL-base merge (client rule) ===');
console.log(`NFULL rows (all kept):          ${counts.nfull}`);
console.log(`MFULL rows (total):             ${counts.mfull_total}`);
console.log(`  MFULL omitted (in NFULL):     ${counts.mfull_omitted}`);
console.log(`  MFULL dup collapsed (phone):  ${counts.mfull_dup_collapsed}`);
console.log(`  MFULL-only (kept):            ${counts.mfull_only}`);
console.log(`MERGED TOTAL:                   ${counts.merged_total}`);
console.log(`  check: ${counts.nfull} + ${counts.mfull_only} = ${counts.nfull + counts.mfull_only}  ${okTotal ? '✓' : '✗ MISMATCH'}`);
console.log(`\n(match-key coverage — rows with permalink/post_id/phone: NFULL ${nfullKeyed}/${counts.nfull}, MFULL ${mfullKeyed}/${counts.mfull_total})`);
console.log('(read-only — no data shown, no writes, no cost)');
process.exitCode = okTotal ? 0 : 1;
