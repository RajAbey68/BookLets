'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { LedgerService } from '@/lib/ledger.service';
import { JournalStatus } from '@/lib/types';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';

export type ExpenseRow = Prisma.ExpenseGetPayload<{
  include: { property: true; vendor: true; expenseCategory: true };
}>;

export async function fetchExpenses(): Promise<ExpenseRow[]> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.expense.findMany({
      where: { property: { organizationId } },
      include: { property: true, vendor: true, expenseCategory: true },
      orderBy: { date: 'desc' },
    });
  } catch (error) {
    console.error('[expense.actions] fetchExpenses: DB unreachable:', error);
    return [];
  }
}

export interface ExpenseFormOption {
  id: string;
  name: string;
}

export interface ExpenseFormOptions {
  properties: ExpenseFormOption[];
  categories: ExpenseFormOption[];
  vendors: ExpenseFormOption[];
}

export async function fetchExpenseFormOptions(): Promise<ExpenseFormOptions> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { properties: [], categories: [], vendors: [] };

  const { organizationId } = resolved.context;

  try {
    const [properties, categories, vendors] = await Promise.all([
      prisma.property.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.expenseCategory.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.vendor.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { properties, categories, vendors };
  } catch (error) {
    console.error('[expense.actions] fetchExpenseFormOptions: DB unreachable:', error);
    return { properties: [], categories: [], vendors: [] };
  }
}

export interface CreateExpenseInput {
  propertyId: string;
  expenseCategoryId: string;
  vendorName: string;
  amount: string;
  date: string;
  description: string;
}

export async function createExpense(
  input: CreateExpenseInput,
): Promise<{ success: true } | { success: false; error: string }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;
  const { propertyId, expenseCategoryId, vendorName, amount, date, description } = input;

  if (!propertyId || !expenseCategoryId || !vendorName.trim() || !amount || !date) {
    return { success: false, error: 'All fields except description are required.' };
  }

  const expenseDate = new Date(date);
  if (Number.isNaN(expenseDate.getTime())) {
    return { success: false, error: 'Invalid date.' };
  }

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  try {
    // Verify the property belongs to the caller's org — never trust the client id.
    const property = await prisma.property.findFirst({
      where: { id: propertyId, organizationId },
      select: { id: true },
    });
    if (!property) {
      return { success: false, error: 'Property not found in your organisation.' };
    }

    const category = await prisma.expenseCategory.findUnique({
      where: { id: expenseCategoryId },
      select: { id: true, accountId: true },
    });
    if (!category) {
      return { success: false, error: 'Selected category no longer exists.' };
    }

    // Resolve the cash/bank account (code 1000) and the suspense fallback (9999).
    // Same pattern as automation.service.ts so manual + AI flows post identically.
    const suspenseAccount = await prisma.account.findFirst({
      where: { organizationId, code: '9999' },
      select: { id: true },
    });
    if (!suspenseAccount) {
      return {
        success: false,
        error: 'Suspense account (code 9999) is not seeded for this organisation. Run the seed script.',
      };
    }

    const bankAccount =
      (await prisma.account.findFirst({
        where: { organizationId, code: '1000' },
        select: { id: true },
      })) ?? suspenseAccount;

    const expenseAccountId = category.accountId ?? suspenseAccount.id;

    // Upsert vendor by trimmed name (case-insensitive). Avoids duplicate vendor rows
    // for "Electric Co" vs "electric co" vs "Electric Co.".
    const trimmedVendor = vendorName.trim();
    let vendor = await prisma.vendor.findFirst({
      where: { name: { equals: trimmedVendor, mode: 'insensitive' } },
      select: { id: true },
    });
    if (!vendor) {
      vendor = await prisma.vendor.create({
        data: { name: trimmedVendor },
        select: { id: true },
      });
    }

    // Atomic: Expense row + balanced JournalEntry succeed or fail together.
    await prisma.$transaction(async (tx) => {
      await tx.expense.create({
        data: {
          propertyId,
          expenseCategoryId,
          vendorId: vendor!.id,
          amount: amountNum.toFixed(2),
          date: expenseDate,
          description: description.trim() || null,
        },
      });
    });

    // Post the journal entry through LedgerService so evidence-log + fiscal-period
    // checks fire. LedgerService owns its own transaction.
    await LedgerService.postEntry({
      organizationId,
      date: expenseDate,
      memo: `Expense: ${trimmedVendor}${description.trim() ? ` — ${description.trim()}` : ''}`,
      status: JournalStatus.POSTED,
      makerIdentity: userId,
      tenantId: organizationId,
      lines: [
        { accountId: expenseAccountId, amount: amountNum, isDebit: true },
        { accountId: bankAccount.id, amount: amountNum, isDebit: false },
      ],
    });

    revalidatePath('/expenses');
    revalidatePath('/ledger');
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('[expense.actions] createExpense failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create expense.',
    };
  }
}
