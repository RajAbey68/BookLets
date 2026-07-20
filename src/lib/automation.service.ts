import { prisma, setRlsOrgContext } from './prisma';
import { LedgerService } from './ledger.service';
import { gateAutomatedJournalEntry } from './approval.service';
import { AUTOMATION_MAKER_IDENTITY } from './maker-identity';
import { fetchWithTimeout } from './http';
import { extractReceipt } from './gemini-ocr';

export interface AutomationResult {
  expenseId: string;
  journalEntryId: string;
  confidence: number;
  // Automated extraction is always human-in-the-loop (D3): no SUCCESS
  // status exists — DRAFT→POSTED happens only via 4-eyes sign-off.
  status: 'HIL_REQUIRED';
}

/**
 * RAJ-674 — org-safe resolution of a shared ExpenseCategory's mapped
 * Account. ExpenseCategory has no organization column (deliberately shared
 * reference data), so its accountId may belong to whichever org created that
 * category row first. Using it unconditionally would carry a foreign org's
 * GL account onto this org's journal line — a real cross-tenant leak, since
 * Account IS org-scoped. Falls back to this org's own Suspense account
 * whenever the mapped account is missing or does not belong to `organizationId`.
 */
async function resolveOrgSafeAccountId(
  mappedAccountId: string | null,
  organizationId: string,
  suspenseAccountId: string,
): Promise<string> {
  if (!mappedAccountId) return suspenseAccountId;
  const ownedAccount = await prisma.account.findFirst({
    where: { id: mappedAccountId, organizationId },
    select: { id: true },
  });
  return ownedAccount?.id ?? suspenseAccountId;
}

export class AutomationService {
  private static SYMBIOS_URL = process.env.SYMBIOS_URL || 'http://localhost:8080';

  /**
   * Processes a receipt by sending it to SymbiOS for vision extraction and then recording it in the ledger.
   */
  static async processReceipt(
    organizationId: string,
    propertyId: string,
    imageBase64: string,
    metadata: { source: 'WEB' | 'MOBILE' } = { source: 'WEB' }
  ): Promise<AutomationResult> {
    console.log('[Middleware Agent] Processing receipt', { source: metadata.source, org: organizationId });

    // Pre-flight: surface bad context up-front instead of failing partway
    // through with a foreign-key error inside the ledger transaction.
    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    });
    if (!property) {
      throw new Error(`Receipt context invalid: property ${propertyId} not found for organization ${organizationId}.`);
    }

    // 1. Vision Extraction — Gemini Flash Vision OCR with SymbiOS fallback
    // Try Google Gemini Flash Vision first (handles English + Sinhala receipts).
    // Falls back to SymbiOS if Gemini is unavailable, times out, or returns low confidence.
    let vendorName: string;
    let date: string;
    let totalAmount: number;
    let categorySuggestion: string;
    let confidence: number;

    try {
      const geminiResult = await extractReceipt(imageBase64);
      const extraction = geminiResult.extraction;
      vendorName = extraction.vendorName;
      date = extraction.date;
      totalAmount = extraction.totalAmount;
      categorySuggestion = extraction.categorySuggestion;
      confidence = extraction.confidence;
      console.log(`[Middleware Agent] Gemini OCR succeeded — vendor="${vendorName}" confidence=${confidence}`);
    } catch (geminiErr) {
      const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      console.warn(`[Middleware Agent] Gemini OCR failed (${msg}), falling back to SymbiOS...`);

      // Fallback to SymbiOS
      const response = await fetchWithTimeout(`${this.SYMBIOS_URL}/api/v1/automation/extract-receipt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-maker-identity': AUTOMATION_MAKER_IDENTITY,
          'x-tenant-id': organizationId,
          'x-agent-confidence': '1.0',
        },
        body: JSON.stringify({ image: imageBase64 }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const detail = body ? ` - ${body.slice(0, 500)}` : '';
        throw new Error(`SymbiOS Extraction Failed: ${response.status} ${response.statusText}${detail}`);
      }

      const { extraction } = await response.json();
      vendorName = extraction.vendorName;
      date = extraction.date;
      totalAmount = extraction.totalAmount;
      categorySuggestion = extraction.categorySuggestion;
      confidence = extraction.confidence;
      console.log(`[Middleware Agent] SymbiOS fallback succeeded — vendor="${vendorName}" confidence=${confidence}`);
    }

    // D3 conf-gate: machine-extracted entries ALWAYS land as DRAFT — no
    // confidence score (including exactly 1.0) authorises auto-posting.
    // DRAFT→POSTED happens only via human 4-eyes sign-off in
    // decideDraftJournalEntry. Runs BEFORE any writes: vendor/category
    // resolution below can create persistent rows outside the transaction,
    // so an out-of-contract confidence (NaN / outside [0, 1]) must fail here.
    const gate = gateAutomatedJournalEntry(confidence);

    // A missing/unparseable amount is normalised to 0 by extraction. The
    // zero-amount-line check in LedgerService only guards POSTED entries,
    // so a zero-value DRAFT could later be approved into the ledger.
    // Reject it up front — the receipt needs re-scanning or manual entry.
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      throw new Error(
        `Extraction returned a non-positive total (${totalAmount}) for vendor "${vendorName}" — ` +
        'cannot create a journal draft without a real amount. Re-scan the receipt or enter it manually.'
      );
    }

    // 2. Resolve/Create Vendor
    let vendor = await prisma.vendor.findFirst({
      where: { name: { contains: vendorName } }
    });

    if (!vendor) {
      vendor = await prisma.vendor.create({
        data: { name: vendorName }
      });
    }

    // 3. Resolve Category and GL Account.
    // Both Suspense (code 9999) and Primary Bank (code 1000) must be seeded
    // before this service runs — see prisma/seed.ts.
    const suspenseAccount = await prisma.account.findFirst({
      where: { organizationId, code: '9999' }
    });
    if (!suspenseAccount) {
      throw new Error('Automation Setup Error: Suspense account (code 9999) is not seeded for this organization.');
    }

    // Resolve/create the category row for the Expense record's label FK —
    // ExpenseCategory is intentionally shared/global reference data (no
    // organization column), so this name match is fine on its own.
    let category = await prisma.expenseCategory.findFirst({
      where: { name: { contains: categorySuggestion } }
    });
    if (!category) {
      category = await prisma.expenseCategory.create({
        data: { name: categorySuggestion, accountId: suspenseAccount.id }
      });
    }

    // RAJ-674: the category row is shared across orgs, but its accountId is
    // org-scoped. A name match against a category some OTHER org created (and
    // therefore pointed at ITS OWN account) must never carry that foreign
    // Account onto this org's journal line — verify the mapped account
    // actually belongs to THIS organization before using it (same guard
    // src/lib/ocr-bridge.deps.ts resolveExpenseAccountId already applies for
    // the newer S1b path; this backports it here).
    const expenseAccountId = await resolveOrgSafeAccountId(
      category.accountId,
      organizationId,
      suspenseAccount.id,
    );

    // Resolve Bank Account by code, fall back to name match, then Suspense.
    const bankAccount =
      (await prisma.account.findFirst({ where: { organizationId, code: '1000' } })) ??
      (await prisma.account.findFirst({ where: { organizationId, name: { contains: 'Cash' } } }));
    const bankAccountId = bankAccount?.id ?? suspenseAccount.id;

    // 4. Record the Expense and Journal Entry — ONE transaction: the expense
    // row and the journal entry commit or roll back together (postEntry is
    // handed this tx below instead of opening its own).
    return await prisma.$transaction(async (tx) => {
      // S3 (rls-lock): transaction-local RLS org context — explicit org id
      // (review finding #1: never rely on an ambient scope being open).
      await setRlsOrgContext(tx, organizationId);
      // Create Expense Record
      const expense = await tx.expense.create({
        data: {
          propertyId,
          vendorId: vendor!.id,
          expenseCategoryId: category!.id,
          amount: totalAmount,
          date: new Date(date),
          description: `AI-Extracted from receipt. Vendor: ${vendorName}. Category: ${categorySuggestion}`,
          confidenceScore: confidence,
        }
      });

      // Create Ledger Entry — ALWAYS DRAFT for automated extraction (D3).
      // The confidence score is recorded for the audit trail but never
      // decides the status; see gateAutomatedJournalEntry.
      // The open transaction client is passed through (review finding #2):
      // postEntry writes inside THIS transaction, making expense + journal
      // entry atomic and reusing the RLS org context set above.
      const entry = await LedgerService.postEntry({
        organizationId,
        date: new Date(date),
        memo: `AUTOMATED: Receipt for ${vendorName}`,
        status: gate.status,
        // 4-Eyes governance metadata passed through for audit trail.
        // E5: the OCR pipeline is an AUTOMATED maker — the service
        // identity is correct here (the uploading user did not author the
        // extracted figures). Human-initiated paths pass the session
        // user id instead; see src/lib/maker-identity.ts.
        makerIdentity: AUTOMATION_MAKER_IDENTITY,
        tenantId: organizationId,
        agentConfidence: confidence,
        lines: [
          { accountId: expenseAccountId, amount: totalAmount, isDebit: true },
          { accountId: bankAccountId, amount: totalAmount, isDebit: false },
        ]
      }, tx);

      return {
        expenseId: expense.id,
        journalEntryId: entry.id,
        confidence,
        // Human-in-the-loop is unconditional for automated entries (D3):
        // the DRAFT sits in the 4-eyes queue until a checker decides it.
        status: 'HIL_REQUIRED'
      };
    });
  }
}
