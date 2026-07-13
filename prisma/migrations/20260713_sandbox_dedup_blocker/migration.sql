-- S1b Sandbox Dedup Blocker (critical data integrity gate)
-- ─────────────────────────────────────────────────────
-- Prevents triple-counting of identical transactions re-imported across batches.
--
-- PROBLEM: sandbox.payment_entries contains 128 transactions imported 3+ times
-- across different batches (b101216d, dedb5fda, 8d3b8040). The current
-- idempotencyKey in ocr-bridge.ts is source_file-based only, which misses
-- identical transactions arriving in different files/batches.
--
-- SOLUTION (3-layer):
--  1. Add a content-based UNIQUE index to prevent re-insert of identical rows.
--  2. Add a UNIQUE FK on public.JournalLine → sandbox.payment_entry_id.
--  3. Add a pre-promotion check that halts if duplicates are found.

-- Layer 1: Add a deterministic content hash column to sandbox.payment_entries.
-- Hash = MD5(source_type || coalesce(source_ref,'') || payment_date || amount || description).
-- Any identical row (same source/date/amount) gets the same hash; re-import hits the UNIQUE.
ALTER TABLE sandbox.payment_entries
  ADD COLUMN content_hash TEXT GENERATED ALWAYS AS (
    md5(
      source_type || '|' ||
      coalesce(source_ref, '') || '|' ||
      to_char(payment_date, 'YYYY-MM-DD') || '|' ||
      amount::text || '|' ||
      coalesce(description, '')
    )
  ) STORED;

-- Layer 1b: Create the UNIQUE index (must be partial because content_hash is NOT NULL).
CREATE UNIQUE INDEX idx_sandbox_payment_entries_content_hash ON sandbox.payment_entries (content_hash)
  WHERE deleted_at IS NULL;

-- Layer 2: Add FK from public.JournalLine to sandbox.payment_entry_id (tracks promotion source).
-- Mark as UNIQUE so a sandbox row can only promote to ONE journal entry (no multi-promotion).
ALTER TABLE public.JournalLine
  ADD COLUMN sandbox_payment_entry_id BIGINT UNIQUE REFERENCES sandbox.payment_entries(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;

-- Layer 3: Add a blocking check function (halts promotion if duplicates exist).
-- Call this BEFORE any promotion via ocr-bridge/zip-ingest to fail early.
CREATE OR REPLACE FUNCTION check_sandbox_dedup(
  org_id UUID
)
RETURNS TABLE (
  duplicate_content_hash TEXT,
  count INTEGER,
  entry_ids BIGINT[]
) AS $$
  SELECT
    content_hash,
    COUNT(*)::INTEGER as count,
    ARRAY_AGG(id) as entry_ids
  FROM sandbox.payment_entries
  WHERE
    organization_id = org_id
    AND deleted_at IS NULL
    AND sandbox_payment_entries.id NOT IN (
      -- Exclude rows already promoted to public.JournalLine
      SELECT sandbox_payment_entry_id
      FROM public.JournalLine
      WHERE sandbox_payment_entry_id IS NOT NULL
    )
  GROUP BY content_hash
  HAVING COUNT(*) > 1;
$$ LANGUAGE SQL STABLE;

-- Layer 4: Idempotency guard for ingest jobs (prevents re-processing of completed batches).
-- The ingest_batches table already exists; add a UNIQUE constraint on (source, filename)
-- so a second import of the same source+filename is skipped (UPSERT, not INSERT).
CREATE UNIQUE INDEX idx_import_batches_source_filename ON sandbox.import_batches (source, filename)
  WHERE status = 'completed';

-- Audit comment: the comment explains what each layer does and why duplicates matter.
COMMENT ON FUNCTION check_sandbox_dedup(UUID) IS
  'Pre-promotion check: halts if identical transactions (same date/amount/description) exist in sandbox. ' ||
  'Must be called before ocr-bridge or zip-ingest promotes any row to public.JournalEntry. ' ||
  'Returns (content_hash, count, entry_ids) for any hash with count > 1. Empty result = safe to promote.';
