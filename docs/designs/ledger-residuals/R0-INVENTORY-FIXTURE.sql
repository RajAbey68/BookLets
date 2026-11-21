-- Synthetic test data for R0-INVENTORY.sql (part A) and R0-INVENTORY-PARTB.sql.
-- Made-up rows only; no production data.
--
-- Reproduce on a throwaway local Postgres, never production:
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > ddl.sql
--   createdb inv && psql -d inv -f ddl.sql -f R0-INVENTORY-FIXTURE.sql
--   psql -d inv -x -f R0-INVENTORY.sql ; psql -d inv -x -f R0-INVENTORY-PARTB.sql
--
-- Cases (organisation O1 unless stated):
--   B1   pre-paid (P1, linked), cancelled by route one (R1) AND route two (X2)    → both routes, released twice
--   B2   flagged; pre-payment P2 identified by memo only, no link fields          → route one cannot see it: route two posts
--   B3   flagged; no pre-payment                                                  → route two posts
--   B4   pre-paid (P4), route two twice (X4a, X4b), plus a DRAFT route-two (X10)  → repeated; X10 in gap
--   B5   legacy pair: original P5 VOIDED, counter-entry L5 counted                → released more than prepaid
--   B6   confirmed with flag set                                                  → not flagged (not cancelled)
--   B7   flagged; linked pre-payment P7 already reversed by R7                    → route one writes nothing
--   B13  pre-payment P13 in the old 'Booking pre-payment: … (<8 chars>)' form,
--        with a ' | Reversed by …' suffix appended later                         → matched, no gap
--   B14  flagged; revenue already recognised (G14); linked P14 not reversed       → route one posts; flagged after recognition
--   B18  flagged; linked P18 already reversed by legacy counter-entry L18     → route one posts again (flagged)
--   B17  route-two entry X17 later reversed by R17                               → reported, not counted against B17
--   R12  reversal of a manual entry M12                                          → gap: target other
--   L11  legacy counter-entry with unreadable memo                               → gap: target unknown
--   X6   route two for an unknown Hostaway id; X9 for a booking in O2; X16 '#null' → gap: route two unmatched (3)
--   P8   linked pre-payment pointing at a missing booking                         → gap
--   U15  counted entry on the Guest Pre-payments account matching no shape       → gap: unclassified
--   D1   voided draft                                                             → ignored
--   Evidence: E1 ok (R1); E2 points at a missing entry; E4 names the wrong original for R12;
--             E5 for L5 under the wrong organisation; E3 other event type (ignored).
--
-- Expected PART A, O1 (checked 18 Nov 2026 on PostgreSQL 17.11):
--   route_two_entries 7, route_two_entries_later_reversed 1, route_one_new_entries 4,
--   route_one_legacy_entries 3, bookings_both_routes 1, bookings_route_two_repeated 1,
--   bookings_released_more_than_prepaid 3 (B1, B4, B5), bookings_flagged_now 5,
--   flagged_route_one_posts 2 (B14, B18), flagged_route_one_writes_nothing 1 (B7),
--   flagged_route_one_posts_already_legacy_reversed 1 (B18),
--   flagged_route_two_posts 2 (B2, B3), flagged_after_revenue_recognised 1 (B14),
--   gap_route_two_unmatched 3, gap_route_one_target_unknown 1, gap_route_one_target_other 1,
--   gap_prepayment_unmatched 0, gap_prepayment_booking_missing_or_other_org 1,
--   gap_recognition_unmatched 0, gap_cancellation_not_counted 1,
--   gap_unclassified_on_prepayment_account 1, evidence_reversal_events 3,
--   evidence_events_without_entry 1, evidence_counter_entries_without_event 4 (L11, L18, R7, R17),
--   evidence_original_mismatch 1 (R12), evidence_org_mismatch 1 (L5).
-- Expected PART A, O2: evidence_reversal_events 1 (E5), everything else 0.
-- Expected PART B: 39 rows, all for O1.
-- Query 1 on this database: journal_entries_visible 30, journal_lines_visible 4 (not 393/786).

insert into "Organization"(id,name,slug,"updatedAt") values ('O1','Org one','o1',now()),('O2','Org two','o2',now());
insert into "Property"(id,"organizationId",name,address,type,status,"updatedAt") values ('PR1','O1','Villa','x','villa','active',now()),('PR2','O2','Other','x','villa','active',now());
insert into "Channel"(id,name,"updatedAt") values ('C1','direct',now());
insert into "Account"(id,"organizationId",name,type,"updatedAt") values ('A1','O1','Guest Pre-payments','LIABILITY',now()),('A2','O1','Operating Cash','ASSET',now());
insert into "Booking"(id,"propertyId","channelId","checkIn","checkOut","totalAmount",status,"hostawayId","deferredPosted","updatedAt") values
 ('B1','PR1','C1',now(),now(),100,'CANCELLED','101',false,now()),
 ('B2','PR1','C1',now(),now(),100,'CANCELLED','102',true,now()),
 ('B3','PR1','C1',now(),now(),100,'CANCELLED','103',true,now()),
 ('B4','PR1','C1',now(),now(),100,'CONFIRMED','104',true,now()),
 ('B5','PR1','C1',now(),now(),100,'CANCELLED','105',false,now()),
 ('B6','PR1','C1',now(),now(),100,'CONFIRMED','106',true,now()),
 ('B7','PR1','C1',now(),now(),100,'CANCELLED','107',true,now()),
 ('B13-aaaa-rest','PR1','C1',now(),now(),100,'CONFIRMED','113',true,now()),
 ('B14','PR1','C1',now(),now(),100,'CANCELLED','114',true,now()),
 ('B17','PR1','C1',now(),now(),100,'CONFIRMED','117',true,now()),
 ('B18','PR1','C1',now(),now(),100,'CANCELLED','118',true,now()),
 ('B9','PR2','C1',now(),now(),100,'CANCELLED','201',false,now());
insert into "JournalEntry"(id,"organizationId",date,memo,status,source,"sourceId","updatedAt") values
 ('P1','O1',now(),'Booking pre-payment: Villa (B1)','POSTED','booking','B1',now()),
 ('R1','O1',now(),'AUTO-REVERSAL: [Original Entry ID: P1] - Reason: Booking Cancellation','POSTED','reversal','P1',now()),
 ('X2','O1',now(),'Cancellation Reversal: Refund for Booking #101 at Villa','POSTED',null,null,now()),
 ('P2','O1',now(),'Initial Booking Funds: #102 at Villa','POSTED',null,null,now()),
 ('P4','O1',now(),'Initial Booking Funds: #104 at Villa','POSTED','booking','B4',now()),
 ('X4a','O1',now(),'Cancellation Reversal: Refund for Booking #104 at Villa','POSTED',null,null,now()),
 ('X4b','O1',now(),'Cancellation Reversal: Refund for Booking #104 at Villa','POSTED',null,null,now()),
 ('X10','O1',now(),'Cancellation Reversal: Refund for Booking #104 at Villa','DRAFT',null,null,now()),
 ('P5','O1',now(),'Initial Booking Funds: #105 at Villa | Reversed by L5','VOIDED',null,null,now()),
 ('L5','O1',now(),'AUTO-REVERSAL: [Original Entry ID: P5] - Reason: Booking Cancellation','POSTED',null,null,now()),
 ('P6','O1',now(),'Booking pre-payment: Villa (B6)','POSTED','booking','B6',now()),
 ('P7','O1',now(),'Booking pre-payment: Villa (B7)','POSTED','booking','B7',now()),
 ('R7','O1',now(),'AUTO-REVERSAL: [Original Entry ID: P7] - Reason: Booking Cancellation','POSTED','reversal','P7',now()),
 ('X6','O1',now(),'Cancellation Reversal: Refund for Booking #999 at Villa','POSTED',null,null,now()),
 ('X9','O1',now(),'Cancellation Reversal: Refund for Booking #201 at Villa','POSTED',null,null,now()),
 ('X16','O1',now(),'Cancellation Reversal: Refund for Booking #null at Villa','POSTED',null,null,now()),
 ('M12','O1',now(),'manual accrual','POSTED',null,null,now()),
 ('R12','O1',now(),'AUTO-REVERSAL: [Original Entry ID: M12] - Reason: fix','POSTED','reversal','M12',now()),
 ('P8','O1',now(),'Booking pre-payment: gone','POSTED','booking','NOPE',now()),
 ('L11','O1',now(),'AUTO-REVERSAL: [Original Entry ID: broken','POSTED',null,null,now()),
 ('P13','O1',now(),'Booking pre-payment: Villa (B13-aaaa) | Reversed by Z9','POSTED',null,null,now()),
 ('P14','O1',now(),'Booking pre-payment: Villa (B14)','POSTED','booking','B14',now()),
 ('G14','O1',now(),'Revenue Recognition: Guest checkout for Booking #114 at Villa','POSTED',null,null,now()),
 ('P17','O1',now(),'Booking pre-payment: Villa (B17)','POSTED','booking','B17',now()),
 ('X17','O1',now(),'Cancellation Reversal: Refund for Booking #117 at Villa','POSTED',null,null,now()),
 ('R17','O1',now(),'AUTO-REVERSAL: [Original Entry ID: X17] - Reason: fix','POSTED','reversal','X17',now()),
 ('P18','O1',now(),'Booking pre-payment: Villa (B18)','POSTED','booking','B18',now()),
 ('L18','O1',now(),'AUTO-REVERSAL: [Original Entry ID: P18] - Reason: Booking Cancellation','POSTED',null,null,now()),
 ('U15','O1',now(),'old import','POSTED',null,null,now()),
 ('D1','O1',now(),'draft rejected','VOIDED',null,null,now());
insert into "JournalLine"(id,"journalEntryId","accountId",amount,"isDebit") values
 ('JL1','U15','A1',100,false),('JL2','U15','A2',100,true),
 ('JL3','P1','A1',100,false),('JL4','X2','A1',100,true);
insert into "EvidenceLog"(id,"eventType","tenantId","makerIdentity",description,payload,hash) values
 ('E1','JOURNAL_REVERSED','O1','m','d','{"reversalId":"R1","originalEntryId":"P1"}','h1'),
 ('E2','JOURNAL_REVERSED','O1','m','d','{"reversalId":"GONE","originalEntryId":"P9"}','h2'),
 ('E3','JOURNAL_POSTED','O1','m','d','{}','h3'),
 ('E4','JOURNAL_REVERSED','O1','m','d','{"reversalId":"R12","originalEntryId":"WRONG"}','h4'),
 ('E5','JOURNAL_REVERSED','O2','m','d','{"reversalId":"L5","originalEntryId":"P5"}','h5');
