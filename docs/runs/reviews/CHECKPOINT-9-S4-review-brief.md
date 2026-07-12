# ADVERSARIAL REVIEW BRIEF — Checkpoint 9 (S4 conf-gate) — PR #73

## Your role
You are an independent, non-Anthropic adversarial reviewer (Layer 1) for the BookLets
double-entry bookkeeping system. The maker was a Claude agent. Your job is to try to
BLOCK this change. Do not be polite; find real defects. A PASS from you is a signed
gate — only issue it if you cannot break the change.

## Claimed contract (attack these claims)
1. No automated/OCR journal entry can EVER be created with status POSTED — regardless
   of confidence value (0.95, 0.99999, exactly 1.0). All land as DRAFT.
2. The gate is a named domain rule `gateAutomatedJournalEntry(confidence)` in
   src/lib/approval.service.ts, with a literal return type that has no POSTED branch.
3. Invalid confidence (NaN, <0, >1) throws RangeError BEFORE any DB rows are created.
4. The legitimate human promotion path (decideDraftJournalEntry + assertNotSelfApproval,
   four-eyes) is untouched.
5. tsc, eslint (zero warnings), and 260/260 Vitest tests pass.

## Specific attack vectors (from the spec's checkpoint definition)
- Threshold hardcoding: is any `> 0.9`-style magic threshold still live anywhere?
- conf == 1.0 edge: does exactly-1.0 confidence still bypass anything?
- Other call-sites: does ANY other code path create JournalEntry rows with
  status POSTED directly (grep for JournalStatus.POSTED and postEntry defaults)?
  Known residual risk the maker admitted: LedgerService.postEntry defaults to POSTED
  when `status` is omitted — is any current call-site exploitable via that default?
- Test theatre: do the 13 new tests actually assert the DB-bound value, or only an
  intermediate variable? Could the tests pass while the real Prisma write still posts?
- The UI change (ReceiptUploader): does the copy change mask rather than fix anything?

## Verdict format (reply exactly)
VERDICT: PASS | BLOCK
checkerIdentity: <your model name/version>
FINDINGS: <numbered list; for BLOCK, each finding must cite file:line from the diff>

## Full diff (origin/main...claude/s4-conf-gate)
```diff
diff --git a/AGENTS_LOG.md b/AGENTS_LOG.md
index 3b53ec1..0de7c5c 100644
--- a/AGENTS_LOG.md
+++ b/AGENTS_LOG.md
@@ -25,6 +25,38 @@ joining this repo should read it before claiming scope here.
 
 ## Active work
 
+### fable5-builder-s4 (claude/s4-conf-gate) — OCR confidence gate (defect D3): automated entries always DRAFT
+- **Started:** 2026-07-12
+- **Goal:** Close defect D3 (FABLE5 spec, service S4 "conf-gate" / M9):
+  `AutomationService.processReceipt` auto-POSTed journal entries when OCR
+  confidence exceeded 0.9. New named domain rule
+  `gateAutomatedJournalEntry` (in `approval.service.ts`, the 4-eyes
+  authority) makes every machine-extracted entry land as DRAFT — no
+  confidence, including exactly 1.0, grants posting authority. The only
+  DRAFT→POSTED path remains the human checker sign-off
+  (`decideDraftJournalEntry`). Strict TDD: RED tests proved the 0.9
+  auto-post, then GREEN.
+- **Touching:**
+  - `src/lib/approval.service.ts` (add `gateAutomatedJournalEntry` + result type)
+  - `src/lib/automation.service.ts` (use the gate; result status always `HIL_REQUIRED`)
+  - `src/components/ReceiptUploader.tsx` (copy: HIL message no longer claims a threshold)
+  - `tests/unit/receipt-confidence-gate.test.ts` (new)
+  - `AGENTS_LOG.md` (this entry)
+- **NOT touching:**
+  - `src/lib/ledger.service.ts` (`postEntry` still defaults to POSTED when
+    `status` is omitted — see out of scope)
+  - `src/lib/prisma.ts` SymbiOS integrity extension (gate composes with it,
+    does not bypass it)
+  - approval actions / 4-eyes flow (unchanged; it stays the sole promotion path)
+- **Out of scope (followups):**
+  - `LedgerService.postEntry` defaulting `status` to POSTED means a future
+    call-site that forgets `status` silently auto-posts; consider requiring
+    an explicit status (or defaulting to DRAFT) for maker identities that
+    are agents.
+  - The SymbiOS fallback path trusts the remote `extraction.confidence`
+    without clamping; the gate now throws on out-of-contract values, but a
+    friendlier degrade (clamp + DRAFT) could be argued.
+
 ### Claude — prime process-handling agent (claude/auth-google-oauth) — auth scaffold (Google OAuth + Vercel target)
 - **Started:** 2026-05-13
 - **Goal:** Scaffold Auth.js v5 with Google OAuth so the operator can let
diff --git a/src/components/ReceiptUploader.tsx b/src/components/ReceiptUploader.tsx
index 47ff866..2c22b1c 100644
--- a/src/components/ReceiptUploader.tsx
+++ b/src/components/ReceiptUploader.tsx
@@ -105,7 +105,7 @@ export const ReceiptUploader: React.FC<ReceiptUploaderProps> = ({
           {status === 'UPLOADING' && 'Reading file...'}
           {status === 'ANALYZING' && 'Gemini 3 Flash is identifying vendors and accounts...'}
           {status === 'SUCCESS' && !showHil && 'The entry has been recorded in the double-entry ledger.'}
-          {status === 'SUCCESS' && showHil && 'Confidence below threshold. Entry queued as DRAFT for human review.'}
+          {status === 'SUCCESS' && showHil && 'Entry recorded as DRAFT and queued for 4-eyes human review before posting.'}
           {status === 'ERROR' && error}
         </p>
 
diff --git a/src/lib/approval.service.ts b/src/lib/approval.service.ts
index 2881baf..cffe6d2 100644
--- a/src/lib/approval.service.ts
+++ b/src/lib/approval.service.ts
@@ -7,6 +7,8 @@
  * without changing this file (and its tests).
  */
 
+import { JournalStatus } from './types';
+
 /** Thrown when the approver is the maker — or is not a usable identity at all. */
 export class SelfApprovalError extends Error {
   constructor(message: string) {
@@ -70,6 +72,40 @@ export function resolveIntentDecision(
   return decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
 }
 
+/**
+ * FABLE5 S4 "conf-gate" (defect D3) — status rule for machine-extracted
+ * journal entries (OCR receipts, agent-proposed postings).
+ *
+ * CONTRACT: an automated extraction ALWAYS lands as DRAFT. No confidence
+ * score — not 0.95, not 0.99999, not even exactly 1.0 — authorises
+ * auto-posting; this function deliberately has no POSTED branch, and the
+ * literal return type makes that guarantee at compile time. The ONLY path
+ * from DRAFT to POSTED is an explicit human checker decision:
+ * resolveDraftJournalDecision + assertNotSelfApproval (4-eyes sign-off,
+ * wired through decideDraftJournalEntry in approval.actions).
+ *
+ * The confidence score is still validated here so a broken extractor
+ * (NaN, negative, > 1) fails loudly BEFORE any ledger rows are created,
+ * and call-sites keep passing it through as `agentConfidence` for the
+ * audit trail — it just grants no posting authority.
+ */
+export interface AutomatedEntryGateResult {
+  /** Status every machine-extracted entry must be created with. Always DRAFT. */
+  status: JournalStatus.DRAFT;
+  /** Human-in-the-loop review is unconditional for automated extraction. */
+  requiresHumanReview: true;
+}
+
+export function gateAutomatedJournalEntry(confidence: number): AutomatedEntryGateResult {
+  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
+    throw new RangeError(
+      `Extraction confidence must be a number within [0, 1]; got ${confidence}. ` +
+        'Refusing to create a ledger entry from an out-of-contract extraction.',
+    );
+  }
+  return { status: JournalStatus.DRAFT, requiresHumanReview: true };
+}
+
 /**
  * DRAFT JournalEntry promotion (RevenueService parks >€10k entries as DRAFT):
  * approve → POSTED, reject → VOIDED. Valid only from DRAFT.
diff --git a/src/lib/automation.service.ts b/src/lib/automation.service.ts
index e0cca49..fbebc45 100644
--- a/src/lib/automation.service.ts
+++ b/src/lib/automation.service.ts
@@ -1,6 +1,6 @@
 import { prisma } from './prisma';
 import { LedgerService } from './ledger.service';
-import { JournalStatus } from './types';
+import { gateAutomatedJournalEntry } from './approval.service';
 import { fetchWithTimeout } from './http';
 import { extractReceipt } from './gemini-ocr';
 
@@ -127,6 +127,13 @@ export class AutomationService {
       (await prisma.account.findFirst({ where: { organizationId, name: { contains: 'Cash' } } }));
     const bankAccountId = bankAccount?.id ?? suspenseAccount.id;
 
+    // D3 conf-gate: machine-extracted entries ALWAYS land as DRAFT — no
+    // confidence score (including exactly 1.0) authorises auto-posting.
+    // DRAFT→POSTED happens only via human 4-eyes sign-off in
+    // decideDraftJournalEntry. Also fails loudly on an out-of-contract
+    // confidence (NaN / outside [0, 1]) before any rows are created.
+    const gate = gateAutomatedJournalEntry(confidence);
+
     // 4. Record the Expense and Journal Entry
     return await prisma.$transaction(async (tx) => {
       // Create Expense Record
@@ -142,12 +149,14 @@ export class AutomationService {
         }
       });
 
-      // Create Ledger Entry — status driven by extraction confidence score
+      // Create Ledger Entry — ALWAYS DRAFT for automated extraction (D3).
+      // The confidence score is recorded for the audit trail but never
+      // decides the status; see gateAutomatedJournalEntry.
       const entry = await LedgerService.postEntry({
         organizationId,
         date: new Date(date),
         memo: `AUTOMATED: Receipt for ${vendorName}`,
-        status: confidence > 0.9 ? JournalStatus.POSTED : JournalStatus.DRAFT,
+        status: gate.status,
         // 4-Eyes governance metadata passed through for audit trail
         makerIdentity: 'booklets-automation-service',
         tenantId: organizationId,
@@ -162,7 +171,9 @@ export class AutomationService {
         expenseId: expense.id,
         journalEntryId: entry.id,
         confidence,
-        status: confidence > 0.9 ? 'SUCCESS' : 'HIL_REQUIRED'
+        // Human-in-the-loop is unconditional for automated entries (D3):
+        // the DRAFT sits in the 4-eyes queue until a checker decides it.
+        status: 'HIL_REQUIRED'
       };
     });
   }
diff --git a/tests/unit/receipt-confidence-gate.test.ts b/tests/unit/receipt-confidence-gate.test.ts
new file mode 100644
index 0000000..5cb8c45
--- /dev/null
+++ b/tests/unit/receipt-confidence-gate.test.ts
@@ -0,0 +1,183 @@
+/**
+ * FABLE5 S4 "conf-gate" / defect D3 — OCR confidence must NEVER auto-post.
+ *
+ * CONTRACT: a journal entry derived from automated extraction (OCR/receipt,
+ * agent-proposed) must ALWAYS be created as DRAFT, regardless of the
+ * extraction confidence score — 0.95, 0.99999 and even exactly 1.0 all land
+ * as DRAFT. The ONLY way an automated entry becomes POSTED is the human
+ * 4-eyes sign-off path (resolveDraftJournalDecision + assertNotSelfApproval,
+ * wired through decideDraftJournalEntry). There is no threshold above which
+ * auto-posting is allowed; the gate has no POSTED branch at all.
+ *
+ * Pre-fix defect these tests were written against (RED):
+ *   src/lib/automation.service.ts:150
+ *     status: confidence > 0.9 ? JournalStatus.POSTED : JournalStatus.DRAFT
+ *   src/lib/automation.service.ts:165
+ *     status: confidence > 0.9 ? 'SUCCESS' : 'HIL_REQUIRED'
+ * i.e. any receipt the OCR was merely "quite sure" about (> 0.9) hit the
+ * ledger as POSTED with zero human review.
+ *
+ * Tests follow the repo's unit-test convention: the Prisma singleton and all
+ * IO-bearing collaborators are stubbed via vi.doMock (see
+ * tests/unit/ledger-service.test.ts, tests/unit/booking-ledger-posting.test.ts),
+ * so no database or network is required.
+ */
+import { describe, it, expect, vi, beforeEach } from 'vitest';
+import { JournalStatus } from '../../src/lib/types';
+
+// ─── Test doubles for AutomationService.processReceipt ───────────────────────
+
+const EXTRACTION_BASE = {
+  vendorName: 'Keells Super',
+  date: '2026-07-01',
+  totalAmount: 4500,
+  categorySuggestion: 'Groceries',
+};
+
+function mockDeps(confidence: number) {
+  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
+  const expenseCreate = vi.fn().mockResolvedValue({ id: 'exp-1' });
+
+  vi.doMock('../../src/lib/gemini-ocr', () => ({
+    extractReceipt: vi.fn().mockResolvedValue({
+      extraction: { ...EXTRACTION_BASE, confidence },
+    }),
+  }));
+
+  vi.doMock('../../src/lib/prisma', () => ({
+    prisma: {
+      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
+      vendor: {
+        findFirst: vi.fn().mockResolvedValue({ id: 'ven-1', name: 'Keells Super' }),
+        create: vi.fn(),
+      },
+      account: {
+        // Call order inside processReceipt: Suspense (9999) first, Bank (1000) second.
+        findFirst: vi
+          .fn()
+          .mockResolvedValueOnce({ id: 'acct-suspense', code: '9999' })
+          .mockResolvedValueOnce({ id: 'acct-bank', code: '1000' }),
+      },
+      expenseCategory: {
+        findFirst: vi.fn().mockResolvedValue({ id: 'cat-1', accountId: 'acct-exp' }),
+        create: vi.fn(),
+      },
+      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
+        fn({ expense: { create: expenseCreate } }),
+      ),
+    },
+  }));
+
+  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
+  vi.doMock('../../src/lib/http', () => ({ fetchWithTimeout: vi.fn() }));
+
+  return { postEntry, expenseCreate };
+}
+
+async function processReceiptWithConfidence(confidence: number) {
+  const { postEntry } = mockDeps(confidence);
+  const { AutomationService } = await import('../../src/lib/automation.service');
+  const result = await AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U=');
+  expect(postEntry).toHaveBeenCalledOnce();
+  return { result, entryInput: postEntry.mock.calls[0][0] };
+}
+
+// ─── The named domain rule ────────────────────────────────────────────────────
+
+describe('gateAutomatedJournalEntry (D3 conf-gate domain rule)', () => {
+  // Dynamic import so a missing export fails the individual test instead of
+  // the whole file (this is what proved RED before the rule existed).
+  async function loadGate() {
+    const approval = await import('../../src/lib/approval.service');
+    return (approval as Record<string, unknown>).gateAutomatedJournalEntry as (
+      confidence: number,
+    ) => { status: JournalStatus; requiresHumanReview: boolean };
+  }
+
+  it('returns DRAFT for confidence 0.95 (above the old defective 0.9 auto-post threshold)', async () => {
+    const gate = await loadGate();
+    expect(gate(0.95).status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('returns DRAFT for confidence 0.99999', async () => {
+    const gate = await loadGate();
+    expect(gate(0.99999).status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('returns DRAFT at the exact 1.0 boundary — perfect confidence still needs human sign-off', async () => {
+    const gate = await loadGate();
+    expect(gate(1.0).status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('returns DRAFT for every confidence in [0, 1] — no auto-POST branch exists', async () => {
+    const gate = await loadGate();
+    for (const confidence of [0, 0.25, 0.5, 0.899, 0.9, 0.9000001, 0.95, 0.99999, 1]) {
+      const decision = gate(confidence);
+      expect(decision.status).toBe(JournalStatus.DRAFT);
+      expect(decision.requiresHumanReview).toBe(true);
+    }
+  });
+
+  it('rejects out-of-contract confidence values loudly (NaN, negative, > 1)', async () => {
+    const gate = await loadGate();
+    expect(() => gate(Number.NaN)).toThrow(RangeError);
+    expect(() => gate(-0.01)).toThrow(RangeError);
+    expect(() => gate(1.01)).toThrow(RangeError);
+    expect(() => gate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
+  });
+});
+
+describe('DRAFT→POSTED is only reachable via explicit human + checker sign-off', () => {
+  it('resolveDraftJournalDecision promotes DRAFT to POSTED only on an explicit APPROVE', async () => {
+    const { resolveDraftJournalDecision } = await import('../../src/lib/approval.service');
+    expect(resolveDraftJournalDecision('DRAFT', 'APPROVE')).toBe('POSTED');
+    expect(resolveDraftJournalDecision('DRAFT', 'REJECT')).toBe('VOIDED');
+  });
+
+  it('the sign-off requires a distinct, non-empty checker (no anonymous or self approval)', async () => {
+    const { assertNotSelfApproval, SelfApprovalError } = await import(
+      '../../src/lib/approval.service'
+    );
+    expect(() => assertNotSelfApproval('maker-1', 'maker-1')).toThrow(SelfApprovalError);
+    expect(() => assertNotSelfApproval('maker-1', '')).toThrow(SelfApprovalError);
+    expect(() => assertNotSelfApproval('maker-1', null)).toThrow(SelfApprovalError);
+    expect(() => assertNotSelfApproval('maker-1', 'checker-2')).not.toThrow();
+  });
+});
+
+// ─── AutomationService.processReceipt end-to-end (stubbed IO) ────────────────
+
+describe('AutomationService.processReceipt — OCR confidence gate (D3)', () => {
+  beforeEach(() => vi.resetModules());
+
+  it('creates the journal entry as DRAFT for confidence 0.95 — never auto-POSTed', async () => {
+    const { entryInput } = await processReceiptWithConfidence(0.95);
+    expect(entryInput.status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('creates the journal entry as DRAFT for confidence 0.99999', async () => {
+    const { entryInput } = await processReceiptWithConfidence(0.99999);
+    expect(entryInput.status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('creates the journal entry as DRAFT even at confidence exactly 1.0 (no human+checker sign-off present)', async () => {
+    const { entryInput } = await processReceiptWithConfidence(1.0);
+    expect(entryInput.status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('creates the journal entry as DRAFT for confidence 0.5 (regression fence for the low band)', async () => {
+    const { entryInput } = await processReceiptWithConfidence(0.5);
+    expect(entryInput.status).toBe(JournalStatus.DRAFT);
+  });
+
+  it('reports HIL_REQUIRED at high confidence so the UI routes the entry to the 4-eyes queue', async () => {
+    const { result } = await processReceiptWithConfidence(0.95);
+    expect(result.status).toBe('HIL_REQUIRED');
+  });
+
+  it('preserves the confidence score on the entry for the audit trail (agentConfidence passthrough)', async () => {
+    const { entryInput, result } = await processReceiptWithConfidence(0.97);
+    expect(entryInput.agentConfidence).toBe(0.97);
+    expect(result.confidence).toBe(0.97);
+  });
+});
```
