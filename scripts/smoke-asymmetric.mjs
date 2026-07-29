// Money-free DB-level proof of the asymmetric rule's edge cases (Docker Postgres,
// synthetic data). Complements smoke.mjs by exercising specifically:
//   - two NFULL rows with the SAME phone are BOTH kept (never dedup NFULL vs itself)
//   - an MFULL row whose phone is in NFULL is OMITTED
//   - an MFULL row with a new phone is KEPT; a keyless (no-phone) MFULL row is KEPT
//   - re-ingest is idempotent
import assert from 'node:assert/strict';
import { app } from '../src/server.js';
import { pool } from '../src/db/pool.js';

const TOKEN = process.env.PIPELINE_API_TOKEN;
const PORT = 4198;
let base;
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, `FAILED: ${name}`); passed += 1; console.log(`  ✓ ${name}`); };

const nrow = (company, phone, url) => ({
  'Lead Statement': `${company} statement`, 'Timestamp': '2026-07-12 09:00', 'Company Name': company,
  'Phone Number': phone, 'Lead Proof URL': url,
  'Post Code (Please Put The Full Postcode, Example: CH41 5LH)': 'CH41 5LH'
});
const mrow = (company, phone, url) => ({
  'Timestamp': '2026-07-12 08:40', 'Company Name': company, 'Primary Contact': phone,
  'Lead Proof URL': url, 'Business Note': `${company} note`
});

// Two NFULL rows share a phone (01111 111111) but differ in content → both kept.
const NFULL = [
  nrow('Alpha One', '01111 111111', 'https://www.facebook.com/a/posts/1'),
  nrow('Alpha Two', '01111 111111', 'https://www.facebook.com/a/posts/2'),
  nrow('Beta', '02222 222222', 'https://www.facebook.com/b/posts/3')
];
const MFULL = [
  mrow('Alpha Dup', '+44 1111 111111', 'https://www.facebook.com/a/posts/9'), // phone in NFULL → omit
  mrow('Gamma', '03333 333333', 'https://www.facebook.com/g/posts/4'),        // new phone → keep
  mrow('Ghost', '', 'https://www.facebook.com/x/posts/5')                     // no phone → keep
];

const ingest = async (path, rows) => (await fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ rows })
})).json();
const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].c;

async function run() {
  assert.ok(TOKEN, 'PIPELINE_API_TOKEN must be set (.env)');
  await pool.query('TRUNCATE raw_leads, master_leads, lead_sources, pipeline_runs, exports, audit_logs RESTART IDENTITY CASCADE');
  const server = await new Promise((res) => { const s = app.listen(PORT, () => res(s)); });
  base = `http://127.0.0.1:${PORT}`;
  try {
    const n = await ingest('/internal/ingest/nfull', NFULL);
    ok('all 3 NFULL rows kept (incl. 2 sharing a phone)', n.records_inserted === 3);
    ok('NFULL master count = 3', (await count('SELECT count(*)::int c FROM master_leads')) === 3);
    ok('two NFULL masters share the same phone (no self-dedup)',
      (await count(`SELECT count(*)::int c FROM master_leads WHERE match_key = '+441111111111' AND source='NFULL'`)) === 2);

    const m = await ingest('/internal/ingest/mfull', MFULL);
    ok('MFULL: 2 kept (Gamma new-phone, Ghost keyless)', m.records_inserted === 2);
    ok('MFULL: 1 omitted (Alpha Dup phone already in NFULL)', m.duplicates === 1);
    ok('total masters = 5', (await count('SELECT count(*)::int c FROM master_leads')) === 5);
    ok('keyless Ghost kept (null match_key)',
      (await count(`SELECT count(*)::int c FROM master_leads WHERE source='MFULL' AND match_key IS NULL`)) === 1);
    ok('omitted Alpha Dup raw kept but unlinked',
      (await count(`SELECT count(*)::int c FROM raw_leads WHERE source='MFULL' AND master_lead_id IS NULL`)) === 1);

    const reN = await ingest('/internal/ingest/nfull', NFULL);
    const reM = await ingest('/internal/ingest/mfull', MFULL);
    ok('re-ingest idempotent (0 new masters)', reN.records_inserted === 0 && reM.records_inserted === 0);
    ok('master count still 5', (await count('SELECT count(*)::int c FROM master_leads')) === 5);

    // --- MFULL phone-dedup: the rolling ~24h sheet re-lists the same lead with
    //     shifted cells; it must collapse to ONE master (deduped by phone), while
    //     every raw scrape occurrence is retained for audit. ---
    const DELTA_PHONE = '04444 444444';
    const first = { ...mrow('Delta', DELTA_PHONE, 'https://www.facebook.com/d/posts/6'),
      'Timestamp': '2026-07-13 08:00', 'Business Note': 'Delta note v1' };
    const d1 = await ingest('/internal/ingest/mfull', [first]);
    ok('new MFULL phone → +1 master', d1.records_inserted === 1);
    ok('master count now 6', (await count('SELECT count(*)::int c FROM master_leads')) === 6);

    // Same lead re-scraped: same phone, changed non-key cells (note + timestamp + url).
    const second = { ...mrow('Delta Ltd', DELTA_PHONE, 'https://www.facebook.com/d/posts/6?refreshed=1'),
      'Timestamp': '2026-07-14 09:30', 'Business Note': 'Delta note v2 (re-scraped)' };
    const d2 = await ingest('/internal/ingest/mfull', [second]);
    ok('re-listed MFULL lead (same phone) → 0 new masters', d2.records_inserted === 0);
    ok('master count still 6 (deduped by phone)', (await count('SELECT count(*)::int c FROM master_leads')) === 6);
    ok('one master holds the Delta phone',
      (await count(`SELECT count(*)::int c FROM master_leads WHERE source='MFULL' AND match_key='+444444444444'`)) === 1);
    ok('both raw scrape occurrences retained + linked to the one master',
      (await count(`SELECT count(*)::int c FROM raw_leads r
                      JOIN master_leads m ON m.id = r.master_lead_id
                     WHERE r.source='MFULL' AND m.match_key='+444444444444'`)) === 2);

    // Two distinct MFULL rows sharing a phone in ONE batch → one master.
    const SHARED_PHONE = '05555 555555';
    const bN = await ingest('/internal/ingest/nfull', []); void bN; // no-op keep base intact
    const batch = await ingest('/internal/ingest/mfull', [
      { ...mrow('Echo', SHARED_PHONE, 'https://www.facebook.com/e/posts/7'), 'Timestamp': '2026-07-14 10:00' },
      { ...mrow('Echo Trading', SHARED_PHONE, 'https://www.facebook.com/e/posts/8'), 'Timestamp': '2026-07-14 10:05' }
    ]);
    ok('two same-phone MFULL rows in one batch → 1 master', batch.records_inserted === 1);
    ok('master count now 7', (await count('SELECT count(*)::int c FROM master_leads')) === 7);

    // Two phone-less MFULL rows with different content → 2 masters (per-row fallback).
    const keyless = await ingest('/internal/ingest/mfull', [
      { ...mrow('Foxtrot', '', 'https://www.facebook.com/f/posts/10'), 'Timestamp': '2026-07-14 11:00' },
      { ...mrow('Foxtrot Two', '', 'https://www.facebook.com/f/posts/11'), 'Timestamp': '2026-07-14 11:05' }
    ]);
    ok('two distinct phone-less MFULL rows → 2 masters (fallback)', keyless.records_inserted === 2);
    ok('master count now 9', (await count('SELECT count(*)::int c FROM master_leads')) === 9);

    console.log(`\nasymmetric smoke: ${passed} checks passed ✅`);
  } finally {
    server.close();
    await pool.end();
  }
}
run().catch((err) => { console.error('\n❌ asymmetric smoke failed:', err && (err.stack || err.message)); process.exitCode = 1; pool.end(); });
