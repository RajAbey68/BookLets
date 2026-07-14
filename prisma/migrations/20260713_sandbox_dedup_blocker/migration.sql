-- S1b Sandbox Dedup Blocker — data-integrity groundwork (ADDITIVE ONLY)
-- ─────────────────────────────────────────────────────────────────────
-- Corrected 2026-07-14 after validating against the LIVE sandbox schema.
-- The first draft of this migration assumed columns that DO NOT EXIST
-- (organization_id, deleted_at) and a BIGINT id (it is UUID); it would have
-- failed on apply. This version uses only real columns and is deliberately
-- NON-DESTRUCTIVE: it adds a content hash + a diagnostics function so the
-- existing duplicates can be SEEN and reviewed. It does NOT add a UNIQUE
-- constraint, because sandbox.payment_entries already contains duplicate
-- rows (the same 128 payments imported across ≥3 completed batches) and a
-- UNIQUE index would fail immediately. Enforcing uniqueness is a SEPARATE,
-- human-gated step (see NEXT STEPS below) that must run AFTER the existing
-- duplicates are resolved.
--
-- REAL sandbox.payment_entries columns (verified):
--   id uuid, amount numeric, bank_ref text, batch_id uuid, category_id uuid,
--   created_at timestamptz, currency text, description text, entity_id uuid,
--   is_labour bool, notes text, payment_date date, payment_method text,
--   receipt_id uuid, source_ref text, source_type text, status text,
--   updated_at timestamptz.

-- Layer 1 (additive): deterministic content hash.
-- Uses ::text casts only (immutable) so the STORED generated column is legal.
-- date::text and numeric::text are immutable; md5() is immutable.
ALTER TABLE sandbox.payment_entries
  ADD COLUMN IF NOT EXISTS content_hash TEXT GENERATED ALWAYS AS (
    md5(
      coalesce(source_type, '') || '|' ||
      coalesce(source_ref, '')  || '|' ||
      coalesce(payment_date::text, '') || '|' ||
      coalesce(amount::text, '') || '|' ||
      coalesce(description, '')
    )
  ) STORED;

-- Non-unique index: fast duplicate detection now, and the future UNIQUE
-- index (added post-cleanup) can be built CONCURRENTLY off this.
CREATE INDEX IF NOT EXISTS idx_sandbox_payment_entries_content_hash
  ON sandbox.payment_entries (content_hash);

-- Diagnostics: list every content_hash that appears more than once, with the
-- row ids and how many batches they span. NO organization filter — the table
-- has no organization_id column (single-tenant staging owned by the import
-- pipeline). Returns empty when the table is clean.
CREATE OR REPLACE FUNCTION sandbox.find_payment_duplicates()
RETURNS TABLE (
  content_hash TEXT,
  copies       BIGINT,
  batch_count  BIGINT,
  entry_ids    UUID[],
  sample_description TEXT,
  total_amount NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    pe.content_hash,
    count(*)                        AS copies,
    count(DISTINCT pe.batch_id)     AS batch_count,
    array_agg(pe.id ORDER BY pe.created_at) AS entry_ids,
    min(pe.description)             AS sample_description,
    sum(pe.amount)                  AS total_amount
  FROM sandbox.payment_entries pe
  GROUP BY pe.content_hash
  HAVING count(*) > 1;
$$;

COMMENT ON FUNCTION sandbox.find_payment_duplicates() IS
  'Pre-promotion diagnostic: returns every duplicated content_hash in '
  'sandbox.payment_entries with row ids, batch spread, and summed amount. '
  'Empty result = no duplicates. Nothing here is destructive — a human '
  'reviews the output and decides which rows to keep before any UNIQUE '
  'constraint or promotion runs.';

-- ── NEXT STEPS (NOT run here — human/Hermes-gated, destructive) ───────────
-- 1. Review duplicates:
--      SELECT * FROM sandbox.find_payment_duplicates();
-- 2. Keep the earliest row per hash, soft-mark or delete the rest, e.g.:
--      DELETE FROM sandbox.payment_entries pe
--      USING (
--        SELECT id, row_number() OVER (
--          PARTITION BY content_hash ORDER BY created_at
--        ) AS rn
--        FROM sandbox.payment_entries
--      ) d
--      WHERE pe.id = d.id AND d.rn > 1;
-- 3. Only AFTER the table is clean, enforce uniqueness going forward:
--      CREATE UNIQUE INDEX CONCURRENTLY uq_sandbox_payment_entries_content_hash
--        ON sandbox.payment_entries (content_hash);
-- 4. Guard batch re-imports (also needs dedup of completed batches first):
--      CREATE UNIQUE INDEX CONCURRENTLY uq_import_batches_source_filename
--        ON sandbox.import_batches (source, filename) WHERE status = 'completed';
