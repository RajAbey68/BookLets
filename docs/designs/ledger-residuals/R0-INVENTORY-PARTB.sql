-- =============================================================================
-- R0 inventory, part B — item list behind non-zero part A counts
-- =============================================================================
--
-- Status: DRAFT, not run against production. Owner approval needed before any
-- run (roadmap R0-Q1). Read-only: SELECT statements inside a READ ONLY
-- transaction that is rolled back, 30-second statement timeout. Nothing is
-- written. Run with psql or the Supabase CLI (the web SQL editor shows only the
-- last statement's result).
--
-- PART B — one row per item behind a non-zero Part A count: entry and booking
-- ids and status labels only, no amounts and no memo text.
--
-- Run ONLY if Part A shows a non-zero count, and only with the owner's
-- approval for this file specifically. The output is real ledger data: it
-- stays with the owner, is not committed to the repository, and is not pasted
-- into any chat, AI session or external service.
--
-- How entries are recognised (from the code that writes them, src/lib/revenue.service.ts
-- and src/lib/ledger.service.ts):
--   Pre-payment   source = 'booking' (booking = sourceId); or, written before the link
--                 fields existed, memo 'Initial Booking Funds: #<hostawayId> at …' or
--                 'Booking pre-payment: <property> (<first 8 chars of booking id>)'
--                 (the latter matched only when exactly one booking in the org fits).
--                 Voided ones are matched (a legacy pair's original is voided) but not counted.
--   Route one     source = 'reversal', sourceId = <reversed entry>; or legacy memo
--                 'AUTO-REVERSAL: [Original Entry ID: <id>] …'
--   Route two     memo 'Cancellation Reversal: Refund for Booking #<hostawayId> at …'.
--                 One that was itself reversed is reported, not counted against its booking.
--   Recognition   memo 'Revenue Recognition: Guest checkout for Booking #<hostawayId> at …'
--   Anything else posted to the 'Guest Pre-payments' account is reported as unclassified.
--
-- Predictions for flagged bookings (status CANCELLED, deferredPosted = true) come from
-- the current database state and follow the sync code: route one picks the newest
-- counted entry linked by source/sourceId; if that entry already has a counter-entry
-- it writes nothing and clears the flag; if there is no such entry, route two builds an
-- entry from the booking amount. The route-one prediction assumes Hostaway still
-- returns the booking as cancelled; a booking Hostaway has dropped goes to route two.
-- If two linked pre-payments share a createdAt, the code's pick is not defined;
-- this file breaks the tie by id and may differ. A legacy (memo-only) counter-entry
-- is invisible to route one, so a pick it already reversed is released again.
-- =============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- Query 0 — confirm the tables and columns used here exist in schema public.
-- Expect 16 rows. Fewer: stop, the tables are elsewhere.
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('JournalEntry', 'source'), ('JournalEntry', 'sourceId'), ('JournalEntry', 'memo'),
    ('JournalEntry', 'status'), ('JournalEntry', 'organizationId'), ('JournalEntry', 'createdAt'),
    ('JournalLine', 'journalEntryId'), ('JournalLine', 'accountId'), ('Account', 'name'),
    ('Booking', 'hostawayId'), ('Booking', 'status'), ('Booking', 'deferredPosted'),
    ('Booking', 'propertyId'), ('Property', 'organizationId'),
    ('EvidenceLog', 'eventType'), ('EvidenceLog', 'payload')
  )
ORDER BY table_name, column_name;

-- Query 1 — can this role see the data? Row-level security on these tables
-- returns no rows to a role that neither owns them nor bypasses RLS, which
-- would make every count below read zero. Expect journal_lines_visible = 786
-- and journal_entries_visible = 393 (the 17 Nov 2026 check; nothing written
-- since 4 Aug). Anything lower, or zero: stop, the role cannot see the data.
SELECT current_user                                                         AS role,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
       (SELECT count(*) FROM public."JournalEntry")                          AS journal_entries_visible,
       (SELECT count(*) FROM public."JournalLine")                           AS journal_lines_visible,
       (SELECT count(DISTINCT "organizationId") FROM public."JournalEntry") AS organisations_visible;

WITH
bk AS (
  SELECT b.id, b."hostawayId", b.status, b."deferredPosted", p."organizationId" AS org
  FROM public."Booking" b
  JOIN public."Property" p ON p.id = b."propertyId"
),
-- Pre-payment entries, three shapes (see header). VOIDED kept so a legacy
-- pair's original can be matched; only POSTED ones are "counted".
prepay AS (
  SELECT je.id, je."organizationId" AS org, je."createdAt" AS created_at,
         (je.status = 'POSTED') AS counted,
         (je.source = 'booking') AS linked,
         CASE
           WHEN je.source = 'booking' THEN je."sourceId"
           WHEN je.memo LIKE 'Initial Booking Funds: #%' THEN
             (SELECT bk.id FROM bk WHERE bk.org = je."organizationId"
                AND bk."hostawayId" = substring(je.memo FROM '^Initial Booking Funds: #(.*?) at '))
           ELSE
             (SELECT CASE WHEN count(*) = 1 THEN min(bk.id) END FROM bk
               WHERE bk.org = je."organizationId"
                 AND left(bk.id, 8) = substring(regexp_replace(je.memo, ' \| Reversed by .*$', '')
                                                FROM '\(([^()]{8})\)$'))
         END AS booking_id
  FROM public."JournalEntry" je
  WHERE je.status IN ('POSTED', 'VOIDED')
    AND (je.source = 'booking'
         OR (je.source IS NULL AND (je.memo LIKE 'Initial Booking Funds: #%'
                                    OR je.memo LIKE 'Booking pre-payment: %')))
),
-- Route one: counter-entries made by the ledger's reversal function.
r1 AS (
  SELECT je.id, je."organizationId" AS org, je.status,
         CASE WHEN je.source = 'reversal' THEN 'new' ELSE 'legacy' END AS kind,
         CASE WHEN je.source = 'reversal' THEN je."sourceId"
              ELSE substring(je.memo FROM '^AUTO-REVERSAL: \[Original Entry ID: ([^\]]+)\]') END AS target_raw
  FROM public."JournalEntry" je
  WHERE je.source = 'reversal'
     OR (je.source IS NULL AND je.memo LIKE 'AUTO-REVERSAL: [Original Entry ID: %')
),
r1b AS (
  SELECT r1.*,
         t.id AS target_id,                      -- NULL unless the target is a real entry in the same org
         pp.booking_id,
         pp.id IS NOT NULL AS target_is_prepay
  FROM r1
  LEFT JOIN public."JournalEntry" t ON t.id = r1.target_raw AND t."organizationId" = r1.org
  LEFT JOIN prepay pp ON pp.id = t.id
),
-- Route two: cancelling entries built from the booking amount.
r2 AS (
  SELECT je.id, je."organizationId" AS org, je.status,
         substring(je.memo FROM '^Cancellation Reversal: Refund for Booking #(.*?) at ') AS hw
  FROM public."JournalEntry" je
  WHERE je.memo LIKE 'Cancellation Reversal: Refund for Booking #%'
),
r2b AS (
  SELECT r2.*, bk.id AS booking_id,
         EXISTS (SELECT 1 FROM r1b WHERE r1b.target_id = r2.id AND r1b.status = 'POSTED') AS reversed
  FROM r2 LEFT JOIN bk ON bk.org = r2.org AND bk."hostawayId" = r2.hw
),
-- Revenue recognition also releases the pre-payment liability.
recog AS (
  SELECT je.id, je."organizationId" AS org, je.status, bk.id AS booking_id
  FROM public."JournalEntry" je
  LEFT JOIN bk ON bk.org = je."organizationId"
             AND bk."hostawayId" = substring(je.memo FROM '^Revenue Recognition: Guest checkout for Booking #(.*?) at ')
  WHERE je.memo LIKE 'Revenue Recognition: Guest checkout for Booking #%'
),
per_booking AS (
  SELECT bk.id, bk.org,
         (SELECT count(*) FROM prepay WHERE prepay.booking_id = bk.id AND prepay.org = bk.org AND prepay.counted) AS n_prepay,
         (SELECT count(*) FROM r1b WHERE r1b.booking_id = bk.id AND r1b.org = bk.org AND r1b.status = 'POSTED')   AS n_r1,
         (SELECT count(*) FROM r2b WHERE r2b.booking_id = bk.id AND r2b.status = 'POSTED' AND NOT r2b.reversed)  AS n_r2,
         (SELECT count(*) FROM recog WHERE recog.booking_id = bk.id AND recog.status = 'POSTED')                 AS n_recog,
         -- the entry route one would pick: newest counted entry linked to this booking
         (SELECT pp.id FROM prepay pp
           WHERE pp.booking_id = bk.id AND pp.org = bk.org AND pp.linked AND pp.counted
           ORDER BY pp.created_at DESC, pp.id DESC LIMIT 1)                                                                   AS route_one_pick,
         (bk.status = 'CANCELLED' AND bk."deferredPosted")                                                        AS flagged_now
  FROM bk
),
pb AS (
  SELECT per_booking.*,
         CASE
           WHEN NOT flagged_now THEN NULL
           WHEN route_one_pick IS NULL THEN 'route_two_posts'
           WHEN EXISTS (SELECT 1 FROM r1b WHERE r1b.kind = 'new' AND r1b.status = 'POSTED'
                          AND r1b.target_id = route_one_pick) THEN 'route_one_writes_nothing'
           ELSE 'route_one_posts'
         END AS prediction,
         -- route one cannot see a legacy (memo-only) counter-entry, so it would release again
         EXISTS (SELECT 1 FROM r1b WHERE r1b.kind = 'legacy' AND r1b.status = 'POSTED'
                   AND r1b.target_id = route_one_pick) AS pick_has_legacy_reversal
  FROM per_booking
),
ev AS (
  SELECT e.id, e."tenantId" AS org, e.payload->>'reversalId' AS reversal_id,
         e.payload->>'originalEntryId' AS original_id
  FROM public."EvidenceLog" e
  WHERE e."eventType" = 'JOURNAL_REVERSED'
),
-- Counted entries touching the Guest Pre-payments account that match none of the shapes above.
unclassified AS (
  SELECT DISTINCT je.id, je."organizationId" AS org
  FROM public."JournalEntry" je
  JOIN public."JournalLine" jl ON jl."journalEntryId" = je.id
  JOIN public."Account" a ON a.id = jl."accountId" AND a."organizationId" = je."organizationId"
  WHERE je.status = 'POSTED'
    AND a.name = 'Guest Pre-payments'
    AND je.id NOT IN (SELECT id FROM prepay UNION ALL SELECT id FROM r1
                      UNION ALL SELECT id FROM r2 UNION ALL SELECT id FROM recog)
)
SELECT org AS organization_id, item, booking_id, entry_id, detail
FROM (
  SELECT org, 'route_two_entry' AS item, booking_id, id AS entry_id,
         CASE WHEN reversed THEN 'later reversed' END AS detail
    FROM r2b WHERE status = 'POSTED'
  UNION ALL
  SELECT org, 'route_one_' || kind || '_entry', booking_id, id,
         'reverses ' || COALESCE(target_id, 'unknown entry')
    FROM r1b WHERE status = 'POSTED'
  UNION ALL
  SELECT org, 'booking_both_routes', id, NULL,
         'prepay=' || n_prepay || ' r1=' || n_r1 || ' r2=' || n_r2 || ' recog=' || n_recog
    FROM pb WHERE n_r1 > 0 AND n_r2 > 0
  UNION ALL
  SELECT org, 'booking_route_two_repeated', id, NULL, 'r2=' || n_r2
    FROM pb WHERE n_r2 > 1
  UNION ALL
  SELECT org, 'booking_released_more_than_prepaid', id, NULL,
         'prepay=' || n_prepay || ' r1=' || n_r1 || ' r2=' || n_r2 || ' recog=' || n_recog
    FROM pb WHERE n_r1 + n_r2 + n_recog > n_prepay
  UNION ALL
  SELECT org, 'flagged_' || prediction, id, route_one_pick,
         concat_ws('; ', CASE WHEN n_recog > 0 THEN 'revenue already recognised' END,
                         CASE WHEN prediction = 'route_one_posts' AND pick_has_legacy_reversal
                              THEN 'already reversed by a legacy counter-entry' END)
    FROM pb WHERE flagged_now
  UNION ALL
  SELECT org, 'gap_route_two_unmatched', NULL, id,
         CASE WHEN hw IS NULL THEN 'memo unreadable'
              WHEN hw = 'null' THEN 'booking had no Hostaway id'
              ELSE 'no booking with that Hostaway id in this organisation' END
    FROM r2b WHERE booking_id IS NULL
  UNION ALL
  SELECT org, 'gap_route_one_target_unknown', NULL, id, kind
    FROM r1b WHERE target_id IS NULL
  UNION ALL
  SELECT org, 'gap_route_one_target_other', NULL, id, 'reverses ' || target_id
    FROM r1b WHERE target_id IS NOT NULL AND NOT target_is_prepay AND target_id NOT IN (SELECT id FROM r2)
  UNION ALL
  SELECT org, 'gap_prepayment_unmatched', NULL, id, CASE WHEN counted THEN NULL ELSE 'voided' END
    FROM prepay WHERE booking_id IS NULL
  UNION ALL
  SELECT pp.org, 'gap_prepayment_booking_missing_or_other_org', NULL, pp.id, NULL
    FROM prepay pp
   WHERE pp.booking_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM bk WHERE bk.id = pp.booking_id AND bk.org = pp.org)
  UNION ALL
  SELECT org, 'gap_recognition_unmatched', NULL, id, NULL FROM recog WHERE booking_id IS NULL
  UNION ALL
  SELECT org, 'gap_cancellation_not_counted', NULL, id, status FROM r1 WHERE status <> 'POSTED'
  UNION ALL
  SELECT org, 'gap_cancellation_not_counted', NULL, id, status FROM r2 WHERE status <> 'POSTED'
  UNION ALL
  SELECT org, 'gap_unclassified_on_prepayment_account', NULL, id, NULL FROM unclassified
  UNION ALL
  SELECT ev.org, 'evidence_event_without_entry', NULL, NULL, 'event ' || ev.id
    FROM ev WHERE NOT EXISTS (SELECT 1 FROM public."JournalEntry" je WHERE je.id = ev.reversal_id)
  UNION ALL
  SELECT r1.org, 'evidence_counter_entry_without_event', NULL, r1.id, NULL
    FROM r1 WHERE status = 'POSTED' AND NOT EXISTS (SELECT 1 FROM ev WHERE ev.reversal_id = r1.id)
  UNION ALL
  SELECT r1.org, 'evidence_original_mismatch', NULL, r1.id, 'event ' || ev.id
    FROM r1 JOIN ev ON ev.reversal_id = r1.id WHERE ev.original_id IS DISTINCT FROM r1.target_raw
  UNION ALL
  SELECT r1.org, 'evidence_org_mismatch', NULL, r1.id, 'event ' || ev.id
    FROM r1 JOIN ev ON ev.reversal_id = r1.id WHERE ev.org <> r1.org
) items
ORDER BY organization_id, item, booking_id, entry_id;

ROLLBACK;
