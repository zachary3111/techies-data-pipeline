// Pure, no I/O. The client's asymmetric NFULL-base merge rule:
//   - keep EVERY NFULL row (never dedup NFULL against itself);
//   - an MFULL row is OMITTED iff its match-key appears among NFULL's match-keys;
//   - among the remaining MFULL rows, collapse same-phone duplicates to ONE (MFULL
//     self-dedup by phone — mirrors the DB `dedup_key`, so the same lead re-listed
//     across MFULL's rolling ~24h sheet is retained once, not accumulated);
//   - a row with no match-key can't "exist in NFULL" and can't dedup by phone, so it
//     is always kept.
//
//   Merged total = all NFULL rows + all distinct-phone (or keyless) MFULL-only rows.
//
// Inputs are arrays of CANONICAL rows (from `toCanonical`).
import { matchKey } from './matchKey.js';

export function mergeAsymmetric(nfullRows, mfullRows) {
  const nfull = Array.isArray(nfullRows) ? nfullRows : [];
  const mfull = Array.isArray(mfullRows) ? mfullRows : [];

  // The base set of keys present in NFULL (nulls skipped — a keyless NFULL row
  // establishes no key for MFULL to match against).
  const nfullKeys = new Set();
  for (const r of nfull) {
    const k = matchKey(r);
    if (k) nfullKeys.add(k);
  }

  const keptMfull = [];
  const omittedMfull = [];
  const seenMfullKeys = new Set();
  let mfullDupCollapsed = 0;
  for (const r of mfull) {
    const k = matchKey(r);
    if (k && nfullKeys.has(k)) { omittedMfull.push(r); continue; }   // exists in NFULL → omit
    if (k && seenMfullKeys.has(k)) { mfullDupCollapsed += 1; continue; } // same-phone MFULL dup → collapse
    if (k) seenMfullKeys.add(k);
    keptMfull.push(r);                                               // MFULL-only (first of its phone, or keyless) → keep
  }

  const kept = [...nfull, ...keptMfull];
  return {
    kept,
    omitted: omittedMfull,
    counts: {
      nfull: nfull.length,
      mfull_total: mfull.length,
      mfull_omitted: omittedMfull.length,
      mfull_dup_collapsed: mfullDupCollapsed,
      mfull_only: keptMfull.length,
      merged_total: kept.length
    }
  };
}
