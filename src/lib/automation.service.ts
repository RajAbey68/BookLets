import { prisma } from './prisma';
import { LedgerService } from './ledger.service';
import { JournalStatus } from './types';
import { fetchWithTimeout } from './http';

export interface AutomationResult {
  expenseId: string;
  journalEntryId: string;
  confidence: number;
  status: 'SUCCESS' | 'HIL_REQUIRED';
}

export class AutomationService {
  private static SYMBIOS_URL = process.env.SYMBIOS_URL || 'http://localhost:8080';

  /**
   * Canonical vendor-name form used for exact matching and the per-org
   * unique index: trimmed, lowercased, internal whitespace collapsed.
   */
  static normalizeVendorName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Processes a receipt by sending it to SymbiOS for vision extraction and then recording it in the ledger.
   */
  static async processReceipt(
    organizationId: string,
    propertyId: string,
    imageBase64: string,
    metadata: { source: 'WEB' | 'MOBILE' } = { source: 'WEB' }
  ): Promise<AutomationResult> {
    console.log(`[Middleware Agent] Processing receipt from ${metadata.source} for Org: ${organizationId}`);

    // Pre-flight: surface bad context up-front instead of failing partway
    // through with a foreign-key error inside the ledger transaction.
    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    });
    if (!property) {
      throw new Error(`Receipt context invalid: property ${propertyId} not found for organization ${organizationId}.`);
    }

    // 1. Vision Extraction via SymbiOS
    // NOTE: confidence is unknown at extraction time; send a sentinel of 1.0
    // and the real confidence returned by SymbiOS is used for all downstream calls.
    const response = await fetchWithTimeout(`${this.SYMBIOS_URL}/api/v1/automation/extract-receipt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-maker-identity': 'booklets-automation-service',
        'x-tenant-id': organizationId,
        'x-agent-confidence': '1.0', // updated after extraction in subsequent calls
      },
      body: JSON.stringify({ image: imageBase64 }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? ` - ${body.slice(0, 500)}` : '';
      throw new Error(`SymbiOS Extraction Failed: ${response.status} ${response.statusText}${detail}`);
    }

    const { extraction } = await response.json();
    const { vendorName, date, totalAmount, categorySuggestion, confidence } = extraction;

    // 2. Resolve/Create Vendor — ALWAYS scoped to the calling organization.
    // RAJ-513: a bare name `contains` match let two tenants share one Vendor
    // row (cross-tenant bleed). Legacy rows with a NULL organizationId are
    // deliberately not matched (prod verified 2026-07-04: Vendor has 0 rows,
    // so no legacy rows exist — cross-tenant matching WAS the bug).
    //
    // Fix round (finding 2) — deterministic selection order:
    //   1. exact match on normalizedName;
    //   2. else OLDEST contains-match (createdAt asc) — findFirst without an
    //      orderBy returns rows in arbitrary Postgres order, which could
    //      attach the same receipt to different vendors run-to-run;
    //   3. else atomic upsert on the (organizationId, normalizedName) unique
    //      (round 2: replaces manual create + P2002 recovery) — Postgres
    //      resolves the concurrent-create race in one statement, returning
    //      the winner instead of ever surfacing a conflict.
    const normalizedVendorName = AutomationService.normalizeVendorName(vendorName);

    const vendor =
      (await prisma.vendor.findFirst({
        where: { organizationId, normalizedName: normalizedVendorName },
      })) ??
      (await prisma.vendor.findFirst({
        where: { organizationId, name: { contains: vendorName } },
        orderBy: { createdAt: 'asc' },
        take: 1,
      })) ??
      (await prisma.vendor.upsert({
        where: {
          organizationId_normalizedName: {
            organizationId,
            normalizedName: normalizedVendorName,
          },
        },
        update: {}, // exists ⇒ concurrent writer won the race; adopt their row untouched
        create: { name: vendorName, normalizedName: normalizedVendorName, organizationId },
      }));

    // 3. Resolve Category and GL Account.
    // Both Suspense (code 9999) and Primary Bank (code 1000) must be seeded
    // before this service runs — see prisma/seed.ts.
    const suspenseAccount = await prisma.account.findFirst({
      where: { organizationId, code: '9999' }
    });
    if (!suspenseAccount) {
      throw new Error('Automation Setup Error: Suspense account (code 9999) is not seeded for this organization.');
    }

    let category = await prisma.expenseCategory.findFirst({
      where: { name: { contains: categorySuggestion } }
    });

    if (!category) {
      category = await prisma.expenseCategory.create({
        data: {
          name: categorySuggestion,
          // Default to the Suspense account if no mapping exists
          accountId: suspenseAccount.id,
        }
      });
    }

    const expenseAccountId = category.accountId || suspenseAccount.id;

    // Resolve Bank Account by code, fall back to name match, then Suspense.
    const bankAccount =
      (await prisma.account.findFirst({ where: { organizationId, code: '1000' } })) ??
      (await prisma.account.findFirst({ where: { organizationId, name: { contains: 'Cash' } } }));
    const bankAccountId = bankAccount?.id ?? suspenseAccount.id;

    // 4. Record the Expense and Journal Entry
    return await prisma.$transaction(async (tx) => {
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

      // Create Ledger Entry — status driven by real SymbiOS confidence score
      const entry = await LedgerService.postEntry({
        organizationId,
        date: new Date(date),
        memo: `AUTOMATED: Receipt for ${vendorName}`,
        status: confidence > 0.9 ? JournalStatus.POSTED : JournalStatus.DRAFT,
        // 4-Eyes governance metadata passed through for audit trail
        makerIdentity: 'booklets-automation-service',
        tenantId: organizationId,
        agentConfidence: confidence,
        lines: [
          { accountId: expenseAccountId, amount: totalAmount, isDebit: true },
          { accountId: bankAccountId, amount: totalAmount, isDebit: false },
        ]
      });

      return {
        expenseId: expense.id,
        journalEntryId: entry.id,
        confidence,
        status: confidence > 0.9 ? 'SUCCESS' : 'HIL_REQUIRED'
      };
    });
  }
}
