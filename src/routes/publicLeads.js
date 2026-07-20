// Public read API — doc section 7's "one endpoint" the frontends read from.
// X-API-Key authed (used server-side by each frontend's proxy). Returns rows
// shaped with the 9 display columns both apps already render, plus a source
// badge. In M1 there is no validation status yet; M2 adds the status filter.
import express from 'express';
import { requireApiKey } from '../lib/auth.js';
import { pool } from '../db/pool.js';
import { EXPECTED_HEADERS, toLeadRow } from '../lib/canonical.js';

export const publicRouter = express.Router();

publicRouter.use(requireApiKey);

// Merge all of a master's raw payloads into one display row: for each display
// column, take the first non-empty value across sources (so a BOTH lead shows
// MFULL's richer address even if NFULL's payload lacked it).
function toDisplayRow(row) {
  // Build display values from the canonical master (schema-agnostic) + merged raw
  // payloads, so NFULL and MFULL leads both populate the display columns.
  const leadRow = toLeadRow({
    message: row.message,
    scrape_timestamp: row.scrape_timestamp,
    business_name: row.business_name,
    phone: row.phone,
    phone2: row.phone2,
    postcode: row.postcode,
    address1: row.address1,
    location: row.location,
    url: row.url,
    post_timestamp: row.post_timestamp,
    email: row.email
  }, {});
  const merged = {};
  for (const header of EXPECTED_HEADERS) merged[header] = leadRow[header] ?? '';

  const uniqueSources = [...new Set(row.sources)].sort();
  merged.source = uniqueSources.length === 2 ? 'BOTH' : uniqueSources[0];
  merged.master_id = row.master_id;
  merged.validation_status = row.status;
  merged.exported = row.exported;
  merged.possible_duplicate_of = row.possible_duplicate_of;
  return merged;
}

function buildFilters(query) {
  const where = ['1=1'];
  const having = [];
  const params = [];

  if (query.date) {
    params.push(query.date);
    where.push(`m.created_at::date = $${params.length}`);
  }
  if (query.exported === 'true' || query.exported === 'false') {
    const want = query.exported === 'true';
    params.push(want);
    where.push(`EXISTS (SELECT 1 FROM exports e WHERE e.master_lead_id = m.id) = $${params.length}`);
  }
  if (query.status) {
    params.push(String(query.status).toUpperCase());
    where.push(`m.status = $${params.length}`);
  }

  const source = (query.source || '').toUpperCase();
  if (source === 'BOTH') {
    having.push('count(DISTINCT ls.source) = 2');
  } else if (source === 'NFULL' || source === 'MFULL') {
    params.push(source);
    having.push(`$${params.length} = ANY(array_agg(DISTINCT ls.source::text))`);
  }

  return {
    whereSql: where.join(' AND '),
    havingSql: having.length ? `HAVING ${having.join(' AND ')}` : '',
    params
  };
}

publicRouter.get('/leads', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 100, 1), 500);
    const offset = (page - 1) * pageSize;
    const format = (req.query.format || 'json').toLowerCase();
    // CSV returns the FULL matching set (the frontends load it whole, like the old
    // backend CSV); JSON stays paginated.
    const limit = format === 'csv' ? 100000 : pageSize;
    const effOffset = format === 'csv' ? 0 : offset;

    const { whereSql, havingSql, params } = buildFilters(req.query);

    const countSql = `
      SELECT count(*) AS total FROM (
        SELECT m.id
          FROM master_leads m
          JOIN lead_sources ls ON ls.master_lead_id = m.id
         WHERE ${whereSql}
         GROUP BY m.id
         ${havingSql}
      ) sub`;
    const totalRes = await pool.query(countSql, params);
    const total = Number(totalRes.rows[0].total);

    const dataSql = `
      SELECT m.id AS master_id,
             m.created_at,
             m.status,
             m.possible_duplicate_of,
             m.message, m.scrape_timestamp, m.business_name, m.phone, m.phone2,
             m.postcode, m.address1, m.location, m.url, m.post_timestamp, m.email,
             array_agg(DISTINCT ls.source::text) AS sources,
             EXISTS (SELECT 1 FROM exports e WHERE e.master_lead_id = m.id) AS exported
        FROM master_leads m
        JOIN lead_sources ls ON ls.master_lead_id = m.id
       WHERE ${whereSql}
       GROUP BY m.id
       ${havingSql}
       -- Match the displayed "Timestamp" column and return oldest leads first.
       ORDER BY m.scrape_timestamp ASC NULLS LAST, m.id ASC
       LIMIT ${limit} OFFSET ${effOffset}`;
    const dataRes = await pool.query(dataSql, params);

    const leads = dataRes.rows.map(toDisplayRow);

    if (format === 'csv') {
      const csv = toCsv(leads);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=most_recent_leads_with_hyperlinks.csv');
      return res.send(csv);
    }

    return res.json({
      ok: true,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      leads
    });
  } catch (err) {
    console.error('[api:leads]', err.message);
    return res.status(500).json({ error: 'Failed to fetch leads.', details: err.message });
  }
});

publicRouter.get('/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM master_leads) AS combined_unique,
        (SELECT count(*) FROM raw_leads) AS total_occurrences,
        (SELECT count(*) FROM raw_leads) - (SELECT count(*) FROM master_leads) AS duplicates_removed,
        (SELECT count(*) FROM master_leads WHERE possible_duplicate_of IS NOT NULL) AS flagged_possible_duplicates,
        (SELECT count(*) FROM lead_sources WHERE source = 'NFULL') AS nfull_total,
        (SELECT count(*) FROM lead_sources WHERE source = 'MFULL') AS mfull_total,
        (SELECT count(*) FROM lead_sources WHERE source = 'NFULL' AND first_seen::date = current_date) AS nfull_today,
        (SELECT count(*) FROM lead_sources WHERE source = 'MFULL' AND first_seen::date = current_date) AS mfull_today,
        (SELECT count(*) FROM (
            SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id HAVING count(DISTINCT source) = 2
        ) b) AS found_by_both,
        (SELECT count(*) FROM (
            SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id
            HAVING count(DISTINCT source) = 1 AND max(source::text) = 'NFULL'
        ) n) AS nfull_only,
        (SELECT count(*) FROM (
            SELECT master_lead_id FROM lead_sources GROUP BY master_lead_id
            HAVING count(DISTINCT source) = 1 AND max(source::text) = 'MFULL'
        ) mo) AS mfull_only
    `);
    const s = rows[0];

    const vres = await pool.query(`
      SELECT
        (SELECT count(*) FROM master_leads WHERE status = 'APPROVED') AS approved,
        (SELECT count(*) FROM master_leads WHERE status = 'REVIEW_REQUIRED') AS review_required,
        (SELECT count(*) FROM master_leads WHERE status = 'REJECTED') AS rejected,
        (SELECT count(*) FROM master_leads WHERE status IN ('INGESTED','READY_FOR_VALIDATION','VALIDATING')) AS pending,
        (SELECT count(*) FROM validation_jobs WHERE status = 'FAILED') AS validation_failures,
        (SELECT count(*) FROM validation_results WHERE layer = 'deterministic') AS rejected_before_ai,
        (SELECT count(*) FROM validation_results WHERE layer = 'ai') AS ai_calls,
        (SELECT coalesce(sum(ai_cost_usd), 0) FROM validation_results) AS total_ai_cost_usd,
        (SELECT round(avg(extract(epoch FROM (vr.validated_at - vj.created_at))))
           FROM validation_results vr JOIN validation_jobs vj ON vj.id = vr.job_id) AS avg_validation_seconds
    `);
    const v = vres.rows[0];
    const approved = Number(v.approved);
    const totalCost = Number(v.total_ai_cost_usd);
    const validation = {
      approved,
      review_required: Number(v.review_required),
      rejected: Number(v.rejected),
      pending: Number(v.pending),
      validation_failures: Number(v.validation_failures),
      rejected_before_ai: Number(v.rejected_before_ai),
      ai_calls: Number(v.ai_calls),
      avg_validation_seconds: v.avg_validation_seconds != null ? Number(v.avg_validation_seconds) : null,
      // cost per approved lead — the doc's key figure. Null until the validator
      // reports token usage (it currently does not expose it to the pipeline).
      total_ai_cost_usd: totalCost,
      cost_per_approved_lead: approved > 0 && totalCost > 0 ? totalCost / approved : null
    };

    return res.json({
      ok: true,
      overview: {
        nfull_today: Number(s.nfull_today),
        mfull_today: Number(s.mfull_today),
        combined_unique: Number(s.combined_unique),
        duplicates_removed: Number(s.duplicates_removed),
        flagged_possible_duplicates: Number(s.flagged_possible_duplicates)
      },
      source_comparison: {
        nfull_total: Number(s.nfull_total),
        mfull_total: Number(s.mfull_total),
        nfull_only: Number(s.nfull_only),
        mfull_only: Number(s.mfull_only),
        found_by_both: Number(s.found_by_both)
      },
      validation
    });
  } catch (err) {
    console.error('[api:stats]', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats.', details: err.message });
  }
});

// Mark leads as exported/delivered. Body: { master_ids: number[], context?: string }
publicRouter.post('/exports', async (req, res) => {
  try {
    const ids = req.body?.master_ids;
    const context = req.body?.context || null;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '`master_ids` must be a non-empty array.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO exports (master_lead_id, context)
       SELECT unnest($1::bigint[]), $2
       RETURNING id`,
      [ids, context]
    );
    return res.json({ ok: true, exported: rows.length });
  } catch (err) {
    console.error('[api:exports]', err.message);
    return res.status(500).json({ error: 'Failed to record exports.', details: err.message });
  }
});

// Minimal CSV serializer for the display rows (mirrors the old CSV shape).
function toCsv(leads) {
  const headers = [...EXPECTED_HEADERS, 'source'];
  const esc = (v) => {
    // Collapse embedded newlines so every record is ONE physical line — the
    // frontends' line-based CSV parser breaks on multi-line quoted fields.
    let s = v === null || v === undefined ? '' : String(v);
    s = s.replace(/[\r\n]+/g, ' ').trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const lead of leads) {
    lines.push(headers.map((h) => esc(lead[h])).join(','));
  }
  return lines.join('\n');
}
