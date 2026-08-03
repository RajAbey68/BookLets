/**
 * Which way an item actually settled, read back out of the server's refusal.
 *
 * approval.service refuses a second decision with
 * `Cannot approve an intent with status "REJECTED". Only PENDING items can be
 * decided.` — the status it refused on is right there, quoted. Without reading
 * it, a losing approver sees their OWN attempt reflected back: click Approve on
 * something a colleague just rejected and the row says "Approved — posted to
 * the ledger". On a four-eyes control that is the worst possible lie, because
 * it says the opposite of what the ledger holds.
 *
 * Only the quoted status is inspected. The message also names the attempted
 * decision in prose ("Cannot approve…"), so searching the whole string would
 * match the attempt rather than the outcome and reintroduce the bug.
 *
 * Lives here rather than beside the buttons so it can be tested without
 * pulling the component's server-action imports into the test environment.
 *
 * Returns null when nothing can be parsed, leaving the caller to fall back
 * rather than guess.
 */
export function settledDecisionFromError(error: string): 'APPROVE' | 'REJECT' | null {
  const status = /status\s+"([A-Z_]+)"/.exec(error)?.[1];
  if (!status) return null;
  // Journal entries settle POSTED/VOIDED; intents APPROVED/REJECTED, or
  // EXECUTED once the approved action has run (approval.service.ts).
  if (status === 'POSTED' || status === 'APPROVED' || status === 'EXECUTED') return 'APPROVE';
  if (status === 'VOIDED' || status === 'REJECTED') return 'REJECT';
  return null;
}
