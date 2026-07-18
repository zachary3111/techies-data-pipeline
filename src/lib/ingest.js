// Set-based bulk ingestion: rows -> canonical -> a staging temp table -> a handful
// of set-based SQL statements per chunk (raw upsert, master dedup upsert, link,
// lead_sources, fuzzy flag). This keeps round-trips ~constant per chunk instead of
// ~6 per row, which is essential over a remote DB (per-row was ~0.8s/row).
import { withTransaction } from '../db/pool.js';
import { toCanonical } from './canonical.js';
import { fingerprint } from './fingerprint.js';
import { startRun, finishRun } from './pipelineRuns.js';
import { RULES_VERSION } from './rules.js';

const MAX_BATCH = 50000;                       // hard safety cap on one call
const CHUNK = Number(process.env.INGEST_CHUNK || 1000);

function cutoverAt() {
  const raw = process.env.PIPELINE_CUTOVER_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const STG_COLS = [
  'source', 'source_record_id', 'dedup_key', 'post_id', 'url', 'owner_name', 'message',
  'post_timestamp', 'scrape_timestamp', 'business_name', 'industry', 'phone', 'phone2', 'email',
  'postcode', 'address1', 'location', 'norm_permalink', 'norm_phone', 'fingerprint', 'raw_payload'
];

async function ingestChunk(client, runId, canonicals) {
  // Build one array per staging column for a single unnest-based bulk insert.
  const c = Object.fromEntries(STG_COLS.map((k) => [k, []]));
  for (const x of canonicals) {
    c.source.push(x.source);
    c.source_record_id.push(x.source_record_id);
    c.dedup_key.push(x.dedup_key);
    c.post_id.push(x.post_id);
    c.url.push(x.url);
    c.owner_name.push(x.owner_name);
    c.message.push(x.message);
    c.post_timestamp.push(x.post_timestamp);
    c.scrape_timestamp.push(x.scrape_timestamp);
    c.business_name.push(x.business_name);
    c.industry.push(x.industry);
    c.phone.push(x.phone);
    c.phone2.push(x.phone2);
    c.email.push(x.email);
    c.postcode.push(x.postcode);
    c.address1.push(x.address1);
    c.location.push(x.location);
    c.norm_permalink.push(x.norm_permalink);
    c.norm_phone.push(x.norm_phone);
    c.fingerprint.push(fingerprint(x));
    c.raw_payload.push(JSON.stringify(x.raw_payload));
  }

  await client.query(`
    CREATE TEMP TABLE stg (
      source lead_source_name, source_record_id text, dedup_key text, post_id text,
      url text, owner_name text, message text, post_timestamp timestamptz,
      scrape_timestamp timestamptz, business_name text, industry text, phone text,
      phone2 text, email text, postcode text, address1 text, location text, norm_permalink text,
      norm_phone text, fingerprint text, raw_payload jsonb
    ) ON COMMIT DROP`);

  await client.query(
    `INSERT INTO stg SELECT * FROM unnest(
       $1::lead_source_name[], $2::text[], $3::text[], $4::text[], $5::text[],
       $6::text[], $7::text[], $8::timestamptz[], $9::timestamptz[], $10::text[],
       $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[],
       $17::text[], $18::text[], $19::text[], $20::text[], $21::jsonb[])`,
    STG_COLS.map((k) => c[k])
  );

  // 1. raw_leads: one row per source occurrence (dedupe within-chunk by key).
  const rawRes = await client.query(
    `INSERT INTO raw_leads (source, source_record_id, raw_payload, pipeline_run_id)
     SELECT DISTINCT ON (source, source_record_id) source, source_record_id, raw_payload, $1
       FROM stg ORDER BY source, source_record_id
     ON CONFLICT (source, source_record_id) DO UPDATE SET
       raw_payload = EXCLUDED.raw_payload,
       received_at = now(),
       pipeline_run_id = EXCLUDED.pipeline_run_id
     RETURNING (xmax = 0) AS inserted`,
    [runId]
  );
  const rawInserted = rawRes.rows.filter((r) => r.inserted).length;
  const rawUpdated = rawRes.rows.length - rawInserted;

  // Compatibility during cutover: an existing pre-phone-key master may still
  // use its old permalink key. Reuse the NFULL-first existing master for that
  // phone so re-ingestion enriches it instead of creating another record.
  await client.query(`
    UPDATE stg s
       SET dedup_key = (
         SELECT m.dedup_key
           FROM master_leads m
          WHERE m.norm_phone = s.norm_phone
          ORDER BY
            EXISTS (
              SELECT 1 FROM lead_sources ls
               WHERE ls.master_lead_id = m.id AND ls.source = 'NFULL'
            ) DESC,
            m.id
          LIMIT 1
       )
     WHERE s.norm_phone IS NOT NULL
       AND EXISTS (SELECT 1 FROM master_leads m WHERE m.norm_phone = s.norm_phone)`);

  // 2. master_leads: one per phone identity. NFULL is selected first when a
  // mixed batch contains both sources.
  const masterRes = await client.query(
    `INSERT INTO master_leads
       (dedup_key, post_id, url, owner_name, message, post_timestamp, scrape_timestamp,
        business_name, industry, phone, phone2, email, postcode, address1, location, norm_permalink, norm_phone, fingerprint, status)
     SELECT DISTINCT ON (dedup_key)
        dedup_key, post_id, url, owner_name, message, post_timestamp, scrape_timestamp,
        business_name, industry, phone, phone2, email, postcode, address1, location, norm_permalink, norm_phone, fingerprint, 'INGESTED'
       FROM stg
      ORDER BY dedup_key, CASE WHEN source = 'NFULL' THEN 0 ELSE 1 END
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`
  );
  const newMasterIds = masterRes.rows.map((r) => r.id);
  const inserted = newMasterIds.length;

  // Re-ingestion updates masters. NFULL owns conflicting values; MFULL may
  // update MFULL-only masters and fill blanks on NFULL-owned masters.
  await client.query(`
    WITH preferred AS (
      SELECT DISTINCT ON (dedup_key)
        dedup_key, source, post_id, url, owner_name, message, post_timestamp,
        scrape_timestamp, business_name, industry, phone, phone2, email, postcode,
        address1, location, norm_permalink, norm_phone, fingerprint
      FROM stg
      ORDER BY dedup_key, CASE WHEN source = 'NFULL' THEN 0 ELSE 1 END
    )
    UPDATE master_leads m SET
      post_id = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.post_id,m.post_id) ELSE coalesce(m.post_id,p.post_id) END,
      url = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.url,m.url) ELSE coalesce(m.url,p.url) END,
      owner_name = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.owner_name,m.owner_name) ELSE coalesce(m.owner_name,p.owner_name) END,
      message = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.message,m.message) ELSE coalesce(m.message,p.message) END,
      post_timestamp = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.post_timestamp,m.post_timestamp) ELSE coalesce(m.post_timestamp,p.post_timestamp) END,
      scrape_timestamp = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.scrape_timestamp,m.scrape_timestamp) ELSE coalesce(m.scrape_timestamp,p.scrape_timestamp) END,
      business_name = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.business_name,m.business_name) ELSE coalesce(m.business_name,p.business_name) END,
      industry = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.industry,m.industry) ELSE coalesce(m.industry,p.industry) END,
      phone = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.phone,m.phone) ELSE coalesce(m.phone,p.phone) END,
      phone2 = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.phone2,m.phone2) ELSE coalesce(m.phone2,p.phone2) END,
      email = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.email,m.email) ELSE coalesce(m.email,p.email) END,
      postcode = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.postcode,m.postcode) ELSE coalesce(m.postcode,p.postcode) END,
      address1 = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.address1,m.address1) ELSE coalesce(m.address1,p.address1) END,
      location = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.location,m.location) ELSE coalesce(m.location,p.location) END,
      norm_permalink = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.norm_permalink,m.norm_permalink) ELSE coalesce(m.norm_permalink,p.norm_permalink) END,
      norm_phone = coalesce(p.norm_phone,m.norm_phone),
      fingerprint = CASE WHEN p.source = 'NFULL' OR NOT EXISTS (SELECT 1 FROM lead_sources ls WHERE ls.master_lead_id=m.id AND ls.source='NFULL') THEN coalesce(p.fingerprint,m.fingerprint) ELSE coalesce(m.fingerprint,p.fingerprint) END
    FROM preferred p
    WHERE m.dedup_key = p.dedup_key`);

  // 3. link raw_leads -> master via dedup_key.
  await client.query(
    `UPDATE raw_leads r SET master_lead_id = m.id
       FROM stg s JOIN master_leads m ON m.dedup_key = s.dedup_key
      WHERE r.source = s.source AND r.source_record_id = s.source_record_id
        AND r.master_lead_id IS DISTINCT FROM m.id`
  );

  // 4. lead_sources: which sources found each master (dedupe within-chunk).
  await client.query(
    `INSERT INTO lead_sources (master_lead_id, source, source_record_id, raw_lead_id)
     SELECT DISTINCT ON (m.id, s.source) m.id, s.source, s.source_record_id, r.id
       FROM stg s
       JOIN master_leads m ON m.dedup_key = s.dedup_key
       JOIN raw_leads r ON r.source = s.source AND r.source_record_id = s.source_record_id
      ORDER BY m.id, s.source
     ON CONFLICT (master_lead_id, source) DO UPDATE SET last_seen = now(), raw_lead_id = EXCLUDED.raw_lead_id`
  );

  // 5. secondary/fuzzy flag: a NEW master whose business+postcode fingerprint
  //    matches an OLDER master gets flagged for review (never auto-merged).
  let flagged = 0;
  if (newMasterIds.length) {
    const flagRes = await client.query(
      `UPDATE master_leads t
          SET possible_duplicate_of = (
            SELECT min(o.id) FROM master_leads o
             WHERE o.fingerprint = t.fingerprint AND o.id < t.id)
        WHERE t.id = ANY($1)
          AND t.fingerprint IS NOT NULL
          AND t.possible_duplicate_of IS NULL
          AND EXISTS (SELECT 1 FROM master_leads o WHERE o.fingerprint = t.fingerprint AND o.id < t.id)`,
      [newMasterIds]
    );
    flagged = flagRes.rowCount;
    if (flagged) {
      await client.query(
        `INSERT INTO audit_logs (entity, entity_id, action, actor, detail)
         SELECT 'master_lead', id::text, 'possible_duplicate_flagged', 'system',
                jsonb_build_object('possible_duplicate_of', possible_duplicate_of)
           FROM master_leads
          WHERE id = ANY($1) AND possible_duplicate_of IS NOT NULL`,
        [newMasterIds]
      );
    }
  }

  // 6. enqueue validation for NEW post-cutover masters (backfill policy).
  let jobsCreated = 0;
  const cutover = cutoverAt();
  if (cutover && newMasterIds.length) {
    const jobRes = await client.query(
      `INSERT INTO validation_jobs (master_lead_id, status, rules_version)
       SELECT id, 'PENDING', $2 FROM master_leads
        WHERE id = ANY($1) AND scrape_timestamp IS NOT NULL AND scrape_timestamp >= $3
       ON CONFLICT (master_lead_id) WHERE status IN ('PENDING','PROCESSING','RETRY') DO NOTHING
       RETURNING master_lead_id`,
      [newMasterIds, RULES_VERSION, cutover]
    );
    jobsCreated = jobRes.rowCount;
    if (jobsCreated) {
      await client.query(
        `UPDATE master_leads SET status = 'READY_FOR_VALIDATION'
          WHERE id = ANY($1) AND status = 'INGESTED'`,
        [jobRes.rows.map((r) => r.master_lead_id)]
      );
    }
  }

  return { received: canonicals.length, inserted, rawUpdated, flagged, jobsCreated };
}

/**
 * Ingest a list of { source, row } items under one pipeline_run.
 * Returns the doc section-9 counts (with `replayed: true` for idempotent replay).
 */
export async function ingestItems({ items, runSource = null, idempotencyKey = null }) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (items.length > MAX_BATCH) throw new Error(`batch too large (${items.length} > ${MAX_BATCH})`);

  const { run, existing } = await startRun({ source: runSource, idempotencyKey });
  if (!run) {
    return {
      run_id: existing.id, status: existing.status,
      records_received: existing.records_received, records_inserted: existing.records_inserted,
      records_updated: existing.records_updated, duplicates: existing.duplicates,
      errors: existing.errors, detail: existing.detail, replayed: true
    };
  }

  const canonicals = items.map((it) => toCanonical(it.source, it.row));

  let received = 0; let inserted = 0; let updated = 0; let flagged = 0; let jobsCreated = 0; let errors = 0;
  const errorSamples = [];

  for (let i = 0; i < canonicals.length; i += CHUNK) {
    const chunk = canonicals.slice(i, i + CHUNK);
    try {
      const r = await withTransaction((client) => ingestChunk(client, run.id, chunk));
      received += r.received; inserted += r.inserted; updated += r.rawUpdated;
      flagged += r.flagged; jobsCreated += r.jobsCreated;
    } catch (err) {
      errors += chunk.length;
      if (errorSamples.length < 5) errorSamples.push(err.message);
    }
  }

  const duplicates = received - inserted;
  const counts = {
    records_received: items.length,
    records_inserted: inserted,
    records_updated: updated,
    duplicates,
    errors,
    status: errors > 0 && inserted === 0 ? 'FAILED' : 'COMPLETED',
    detail: { possible_duplicates_flagged: flagged, validation_jobs_created: jobsCreated, error_samples: errorSamples }
  };
  await finishRun(run.id, counts);
  return { run_id: run.id, ...counts, replayed: false };
}
