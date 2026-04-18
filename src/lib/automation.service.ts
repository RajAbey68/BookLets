import { prisma } from './prisma';
import { LedgerService } from './ledger.service';
import { JournalStatus } from './types';

export interface AutomationResult {
  expenseId: string;
  journalEntryId: string;
  confidence: number;
  status: 'SUCCESS' | 'HIL_REQUIRED';
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
    console.log(`[Middleware Agent] Processing receipt from ${metadata.source} for Org: ${organizationId}`);
    
    // 1. Vision Extraction via SymbiOS
    const response = await fetch(`${this.SYMBIOS_URL}/api/v1/automation/extract-receipt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64 }),
    });

    if (!response.ok) {
      throw new Error(`SymbiOS Extraction Failed: ${response.statusText}`);
    }

    const { extraction } = await response.json();
    const { vendorName, date, totalAmount, categorySuggestion, confidence } = extraction;

    // 2. Resolve/Create Vendor
    let vendor = await prisma.vendor.findFirst({
      where: { name: { contains: vendorName } }
    });

    if (!vendor) {
      vendor = await prisma.vendor.create({
        data: { name: vendorName }
      });
    }

    // 3. Resolve Category and GL Account
    let category = await prisma.expenseCategory.findFirst({
      where: { name: { contains: categorySuggestion } }
    });

    if (!category) {
      category = await prisma.expenseCategory.create({
        data: { 
          name: categorySuggestion,
          // Default to a 'Suspense' account if no mapping exists
          accountId: 'SUSPENSE_ACC_ID' 
        }
      });
    }

    const expenseAccountId = category.accountId || 'SUSPENSE_ACC_ID';
    
    // Resolve Bank Account
    const bankAccount = await prisma.account.findFirst({
      where: { organizationId, name: { contains: 'Cash' } }
    });
    const bankAccountId = bankAccount?.id || 'PRIMARY_BANK_ACC_ID'; 

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

      // Create Ledger Entry
      const entry = await LedgerService.postEntry({
        organizationId,
        date: new Date(date),
        memo: `AUTOMATED: Receipt for ${vendorName}`,
        status: confidence > 0.9 ? JournalStatus.POSTED : JournalStatus.DRAFT,
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
