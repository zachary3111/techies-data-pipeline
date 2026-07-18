-- Retain MFULL industry data on the canonical master so the merged frontends
-- keep their industry filter after switching away from the legacy 16-column CSV.
ALTER TABLE master_leads ADD COLUMN IF NOT EXISTS industry text;
