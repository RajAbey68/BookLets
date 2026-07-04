-- Migration: RAJ-513 [fix round, finding 4] DB-level tenant invariant
-- Reason: ActionIntentQueue.organizationId was retrofitted nullable
--         (20260703_action_intent_org_scope) with the invariant enforced only
--         in ActionIntentService.enqueue. App-layer-only enforcement leaves a
--         hole for any future writer that bypasses the service; the DB now
--         backstops it.
-- Safety: prod (euqdfxekrxnoibeahogq) verified 2026-07-04 —
--         "ActionIntentQueue" has 0 rows, so SET NOT NULL cannot fail on
--         existing data. Strictly a constraint promotion — no destructive
--         statement; the runtime guard stays as the first line of defence.

ALTER TABLE "ActionIntentQueue" ALTER COLUMN "organizationId" SET NOT NULL;
