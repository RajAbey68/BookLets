-- Migration: RAJ-285 [P1-03] Optimistic locking on JournalEntry
-- Reason: Prevent lost updates from concurrent edits. Every guarded update
--         checks the caller's expected version and increments it atomically;
--         a stale write matches zero rows and is rejected. Existing rows
--         default to version 1.

ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
