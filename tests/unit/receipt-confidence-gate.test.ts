/**
 * FABLE5 S4 "conf-gate" / defect D3 — OCR confidence must NEVER auto-post.
 *
 * CONTRACT: a journal entry derived from automated extraction (OCR/receipt,
 * agent-proposed) must ALWAYS be created as DRAFT, regardless of the
 * extraction confidence score — 0.95, 0.99999 and even exactly 1.0 all land
 * as DRAFT. The ONLY way an automated entry becomes POSTED is the human
 * 4-eyes sign-off path (resolveDraftJournalDecision + assertNotSelfApproval,
 * wired through decideDraftJournalEntry). There is no threshold above which
 * auto-posting is allowed; the gate has no POSTED branch at all.
 *
 * Pre-fix defect these tests were written against (RED):
 *   src/lib/automation.service.ts:150
 *     status: confidence > 0.9 ? JournalStatus.POSTED : JournalStatus.DRAFT
 *   src/lib/automation.service.ts:165
 *     status: confidence > 0.9 ? 'SUCCESS' : 'HIL_REQUIRED'
 * i.e. any receipt the OCR was merely "quite sure" about (> 0.9) hit the
 * ledger as POSTED with zero human review.
 *
 * Tests follow the repo's unit-test convention: the Prisma singleton and all
 * IO-bearing collaborators are stubbed via vi.doMock (see
 * tests/unit/ledger-service.test.ts, tests/unit/booking-ledger-posting.test.ts),
 * so no database or network is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JournalStatus } from '../../src/lib/types';

// ─── Test doubles for AutomationService.processReceipt ───────────────────────

const EXTRACTION_BASE = {
  vendorName: 'Keells Super',
  date: '2026-07-01',
  totalAmount: 4500,
  categorySuggestion: 'Groceries',
};

function mockDeps(
  confidence: number,
  opts: { extraction?: Partial<typeof EXTRACTION_BASE>; existingVendor?: boolean } = {},
) {
  const postEntry = vi.fn().mockResolvedValue({ id: 'je-1' });
  const expenseCreate = vi.fn().mockResolvedValue({ id: 'exp-1' });
  const vendorCreate = vi.fn().mockResolvedValue({ id: 'ven-new' });

  vi.doMock('../../src/lib/gemini-ocr', () => ({
    extractReceipt: vi.fn().mockResolvedValue({
      extraction: { ...EXTRACTION_BASE, ...opts.extraction, confidence },
    }),
  }));

  vi.doMock('../../src/lib/prisma', () => ({
    prisma: {
      property: { findFirst: vi.fn().mockResolvedValue({ id: 'prop-1' }) },
      vendor: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            opts.existingVendor === false ? null : { id: 'ven-1', name: 'Keells Super' },
          ),
        create: vendorCreate,
      },
      account: {
        // Call order inside processReceipt: Suspense (9999) first, Bank (1000) second.
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: 'acct-suspense', code: '9999' })
          .mockResolvedValueOnce({ id: 'acct-bank', code: '1000' }),
      },
      expenseCategory: {
        findFirst: vi.fn().mockResolvedValue({ id: 'cat-1', accountId: 'acct-exp' }),
        create: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ expense: { create: expenseCreate } }),
      ),
    },
  }));

  vi.doMock('../../src/lib/ledger.service', () => ({ LedgerService: { postEntry } }));
  vi.doMock('../../src/lib/http', () => ({ fetchWithTimeout: vi.fn() }));

  return { postEntry, expenseCreate, vendorCreate };
}

async function processReceiptWithConfidence(confidence: number) {
  const { postEntry } = mockDeps(confidence);
  const { AutomationService } = await import('../../src/lib/automation.service');
  const result = await AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U=');
  expect(postEntry).toHaveBeenCalledOnce();
  return { result, entryInput: postEntry.mock.calls[0][0] };
}

// ─── The named domain rule ────────────────────────────────────────────────────

describe('gateAutomatedJournalEntry (D3 conf-gate domain rule)', () => {
  // Dynamic import so a missing export fails the individual test instead of
  // the whole file (this is what proved RED before the rule existed).
  async function loadGate() {
    const approval = await import('../../src/lib/approval.service');
    return (approval as Record<string, unknown>).gateAutomatedJournalEntry as (
      confidence: number,
    ) => { status: JournalStatus; requiresHumanReview: boolean };
  }

  it('returns DRAFT for confidence 0.95 (above the old defective 0.9 auto-post threshold)', async () => {
    const gate = await loadGate();
    expect(gate(0.95).status).toBe(JournalStatus.DRAFT);
  });

  it('returns DRAFT for confidence 0.99999', async () => {
    const gate = await loadGate();
    expect(gate(0.99999).status).toBe(JournalStatus.DRAFT);
  });

  it('returns DRAFT at the exact 1.0 boundary — perfect confidence still needs human sign-off', async () => {
    const gate = await loadGate();
    expect(gate(1.0).status).toBe(JournalStatus.DRAFT);
  });

  it('returns DRAFT for every confidence in [0, 1] — no auto-POST branch exists', async () => {
    const gate = await loadGate();
    for (const confidence of [0, 0.25, 0.5, 0.899, 0.9, 0.9000001, 0.95, 0.99999, 1]) {
      const decision = gate(confidence);
      expect(decision.status).toBe(JournalStatus.DRAFT);
      expect(decision.requiresHumanReview).toBe(true);
    }
  });

  it('rejects out-of-contract confidence values loudly (NaN, negative, > 1)', async () => {
    const gate = await loadGate();
    expect(() => gate(Number.NaN)).toThrow(RangeError);
    expect(() => gate(-0.01)).toThrow(RangeError);
    expect(() => gate(1.01)).toThrow(RangeError);
    expect(() => gate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('DRAFT→POSTED is only reachable via explicit human + checker sign-off', () => {
  it('resolveDraftJournalDecision promotes DRAFT to POSTED only on an explicit APPROVE', async () => {
    const { resolveDraftJournalDecision } = await import('../../src/lib/approval.service');
    expect(resolveDraftJournalDecision('DRAFT', 'APPROVE')).toBe('POSTED');
    expect(resolveDraftJournalDecision('DRAFT', 'REJECT')).toBe('VOIDED');
  });

  it('the sign-off requires a distinct, non-empty checker (no anonymous or self approval)', async () => {
    const { assertNotSelfApproval, SelfApprovalError } = await import(
      '../../src/lib/approval.service'
    );
    expect(() => assertNotSelfApproval('maker-1', 'maker-1')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval('maker-1', '')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval('maker-1', null)).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval('maker-1', 'checker-2')).not.toThrow();
  });
});

// ─── AutomationService.processReceipt end-to-end (stubbed IO) ────────────────

describe('AutomationService.processReceipt — OCR confidence gate (D3)', () => {
  beforeEach(() => vi.resetModules());

  it('creates the journal entry as DRAFT for confidence 0.95 — never auto-POSTed', async () => {
    const { entryInput } = await processReceiptWithConfidence(0.95);
    expect(entryInput.status).toBe(JournalStatus.DRAFT);
  });

  it('creates the journal entry as DRAFT for confidence 0.99999', async () => {
    const { entryInput } = await processReceiptWithConfidence(0.99999);
    expect(entryInput.status).toBe(JournalStatus.DRAFT);
  });

  it('creates the journal entry as DRAFT even at confidence exactly 1.0 (no human+checker sign-off present)', async () => {
    const { entryInput } = await processReceiptWithConfidence(1.0);
    expect(entryInput.status).toBe(JournalStatus.DRAFT);
  });

  it('creates the journal entry as DRAFT for confidence 0.5 (regression fence for the low band)', async () => {
    const { entryInput } = await processReceiptWithConfidence(0.5);
    expect(entryInput.status).toBe(JournalStatus.DRAFT);
  });

  it('reports HIL_REQUIRED at high confidence so the UI routes the entry to the 4-eyes queue', async () => {
    const { result } = await processReceiptWithConfidence(0.95);
    expect(result.status).toBe('HIL_REQUIRED');
  });

  it('preserves the confidence score on the entry for the audit trail (agentConfidence passthrough)', async () => {
    const { entryInput, result } = await processReceiptWithConfidence(0.97);
    expect(entryInput.agentConfidence).toBe(0.97);
    expect(result.confidence).toBe(0.97);
  });
});

// ─── Extraction sanity gates run BEFORE any persistent writes ────────────────
// Vendor/category resolution happens outside the final $transaction, so a
// failure after them would strand orphan rows. Both the confidence gate and
// the amount check must therefore reject before the first create.

describe('extraction sanity gates precede all side-effecting writes', () => {
  beforeEach(() => vi.resetModules());

  it('rejects a zero totalAmount (unparseable-amount normalisation) before any rows are created', async () => {
    const { postEntry, expenseCreate, vendorCreate } = mockDeps(0.97, {
      extraction: { totalAmount: 0 },
      existingVendor: false,
    });
    const { AutomationService } = await import('../../src/lib/automation.service');
    await expect(
      AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U='),
    ).rejects.toThrow(/non-positive total/);
    expect(vendorCreate).not.toHaveBeenCalled();
    expect(expenseCreate).not.toHaveBeenCalled();
    expect(postEntry).not.toHaveBeenCalled();
  });

  it('rejects a negative totalAmount before any rows are created', async () => {
    const { postEntry, vendorCreate } = mockDeps(0.97, {
      extraction: { totalAmount: -125 },
      existingVendor: false,
    });
    const { AutomationService } = await import('../../src/lib/automation.service');
    await expect(
      AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U='),
    ).rejects.toThrow(/non-positive total/);
    expect(vendorCreate).not.toHaveBeenCalled();
    expect(postEntry).not.toHaveBeenCalled();
  });

  it('rejects an out-of-contract confidence before vendor/category writes (gate precedes side effects)', async () => {
    const { postEntry, expenseCreate, vendorCreate } = mockDeps(1.5, { existingVendor: false });
    const { AutomationService } = await import('../../src/lib/automation.service');
    await expect(
      AutomationService.processReceipt('org-1', 'prop-1', 'aW1hZ2U='),
    ).rejects.toThrow(RangeError);
    expect(vendorCreate).not.toHaveBeenCalled();
    expect(expenseCreate).not.toHaveBeenCalled();
    expect(postEntry).not.toHaveBeenCalled();
  });
});
