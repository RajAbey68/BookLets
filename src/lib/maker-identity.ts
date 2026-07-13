/**
 * E5 — canonical maker identity for automated (non-human) ledger writes.
 *
 * Segregation-of-duties contract (CI gate P1.4, maker ≠ checker):
 *
 *  - HUMAN-initiated write paths (manual journal form, booking form,
 *    manual Hostaway sync, approval decisions) must carry the SESSION
 *    user id as `makerIdentity` — `resolveActiveContext().context.userId`
 *    — never this constant, so `assertNotSelfApproval` can bind the real
 *    maker to the real checker.
 *
 *  - AUTOMATED pipelines (OCR receipt extraction and its SymbiOS
 *    fallback) post as this service identity. Their entries always land
 *    as DRAFT (see gateAutomatedJournalEntry) and are promoted only by a
 *    signed-in human checker, so the service identity never approves its
 *    own work.
 *
 * The literal is exported from exactly this one place — do not re-inline
 * the string at call sites (the P1.4 governance gate greps for strays).
 */
export const AUTOMATION_MAKER_IDENTITY = 'booklets-automation-service';
