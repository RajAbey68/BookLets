-- Scrap schema: persistent store for all uploads and data provided by the operator.
-- Applied once via: psql $DATABASE_URL -f prisma/migrations/manual/create_scrap_schema.sql
-- Safe to re-run (all statements use IF NOT EXISTS).

CREATE SCHEMA IF NOT EXISTS scrap;

-- One row per spreadsheet upload session.
CREATE TABLE IF NOT EXISTS scrap.import_sessions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parsed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  filename     TEXT,
  file_hash    TEXT,                   -- sha256 hex; enables dedup on re-upload
  period_label TEXT,
  sheet_name   TEXT,
  row_count    INT,
  net_amount   TEXT,                   -- Decimal serialised as string
  warnings     TEXT[]
);

-- One row per parsed data row within a session.
CREATE TABLE IF NOT EXISTS scrap.import_rows (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID        NOT NULL REFERENCES scrap.import_sessions(id) ON DELETE CASCADE,
  row_number      INT,
  section         TEXT,
  date            DATE,
  description     TEXT,
  amounts         JSONB,      -- [{columnHeader, accountCode, amount}]
  petty_cash      TEXT,       -- Decimal serialised as string, nullable
  warnings        TEXT[]
);

-- General log for any other data the operator provides (pastes, notes, etc.).
CREATE TABLE IF NOT EXISTS scrap.data_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source     TEXT,        -- e.g. 'user_paste', 'session_note'
  label      TEXT,
  content    JSONB
);

CREATE INDEX IF NOT EXISTS import_rows_date_idx    ON scrap.import_rows (date);
CREATE INDEX IF NOT EXISTS import_rows_session_idx ON scrap.import_rows (session_id);
CREATE INDEX IF NOT EXISTS import_sessions_hash_idx ON scrap.import_sessions (file_hash);
CREATE INDEX IF NOT EXISTS data_log_logged_at_idx  ON scrap.data_log (logged_at);
