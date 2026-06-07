'use server';

/**
 * wise.actions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Next.js Server Actions for Wise API integration.
 *
 * 4-Eyes governance pattern:
 *   1. initiatePayment()  → creates quote + transfer (NOT funded yet)
 *   2. User reviews the transfer details in the UI (4-Eyes gate)
 *   3. confirmPayment()   → funds the transfer; optionally posts ledger entry
 *      if the user has selected debit/credit accounts.
 *
 * Ledger auto-posting is OPTIONAL — only triggered when the user
 * explicitly selects both a debit and credit GL account in the UI.
 */

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { WiseService } from '@/lib/wise.service';
import {
  PaymentInitiatePayload,
  PaymentConfirmPayload,
  WiseApiProfile,
  WiseTransferResponse,
} from '@/lib/types';
import type { WiseBalance } from '@/lib/wise.service';


// ─── Profiles ────────────────────────────────────────────────────────────────

/**
 * Fetches all Wise profiles and upserts them into the local DB.
 * Shows both personal and business profiles so the user can select.
 */
export async function getWiseProfiles(
  organizationId?: string
): Promise<
  | { ok: true; profiles: WiseApiProfile[]; success: true; data: WiseApiProfile[] }
  | { ok: false; error: string; success: false }
> {
  try {
    const profiles = await WiseService.getProfiles();

    if (organizationId) {
      for (const p of profiles) {
        const name =
          p.type === 'business'
            ? (p.details.name ?? 'Business')
            : `${p.details.firstName ?? ''} ${p.details.lastName ?? ''}`.trim();

        await prisma.wiseProfile.upsert({
          where: { wiseProfileId: p.id },
          create: {
            wiseProfileId: p.id,
            type: p.type.toUpperCase(),
            name,
            organizationId,
            isDefault: p.type === 'business',
          },
          update: { name, type: p.type.toUpperCase() },
        });
      }
    }

    return { ok: true, profiles, success: true, data: profiles };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wise.actions] getWiseProfiles error:', msg);
    return { ok: false, error: msg, success: false };
  }
}


// ─── Balances ────────────────────────────────────────────────────────────────

export async function getWiseBalances(
  profileId: number
): Promise<{ ok: true; balances: WiseBalance[] } | { ok: false; error: string }> {
  try {
    const balances = await WiseService.getBalances(profileId);
    return { ok: true, balances };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function createWiseBalance(
  profileId: number,
  currency: string
): Promise<{ ok: true; balance: WiseBalance } | { ok: false; error: string }> {
  try {
    const balance = await WiseService.createBalance(profileId, currency);
    revalidatePath('/wise');
    return { ok: true, balance };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ─── Payment Flow (4-Eyes Gate) ──────────────────────────────────────────────

export interface InitiatedPayment {
  localTransferId: string;
  wiseTransferId: number;
  quote: {
    id: string;
    rate: number;
    sourceAmount: number;
    targetAmount: number;
    sourceCurrency: string;
    targetCurrency: string;
    fee: number;
    estimatedDelivery: string;
  };
  recipientId: number;
}

/**
 * STEP 1 — Create quote → recipient → transfer (NOT funded yet).
 * Returns transfer details for the 4-Eyes review screen.
 */
export async function initiatePayment(
  payload: PaymentInitiatePayload,
  organizationId: string
): Promise<{ ok: true; payment: InitiatedPayment } | { ok: false; error: string }> {
  try {
    const localProfile = await prisma.wiseProfile.findFirst({
      where: { wiseProfileId: payload.profileId, organizationId },
    });
    if (!localProfile) {
      return {
        ok: false,
        error: 'Wise profile not found. Please connect your profiles first.',
      };
    }

    const quote = await WiseService.createQuote(
      payload.profileId,
      payload.sourceCurrency,
      payload.targetCurrency,
      payload.sourceAmount
    );

    const payInOption =
      quote.paymentOptions.find((o) => o.payIn === 'BALANCE' && !o.disabled) ??
      quote.paymentOptions[0];

    const fee = payInOption?.fee?.total ?? 0;
    const estimatedDelivery =
      payInOption?.formattedEstimatedDelivery ?? 'unknown';

    const recipient = await WiseService.createRecipient(
      payload.profileId,
      payload
    );

    const transfer = await WiseService.createTransfer(
      quote.id,
      recipient.id,
      payload.reference
    );

    const localTransfer = await prisma.wiseTransfer.create({
      data: {
        wiseTransferId: transfer.id,
        wiseProfileId: localProfile.id,
        status: 'PROCESSING',
        sourceCurrency: transfer.sourceCurrency,
        targetCurrency: transfer.targetCurrency,
        sourceAmount: transfer.sourceValue,
        targetAmount: transfer.targetValue,
        fee,
        exchangeRate: transfer.rate,
        reference: payload.reference,
        recipientName: payload.recipientName,
      },
    });

    return {
      ok: true,
      payment: {
        localTransferId: localTransfer.id,
        wiseTransferId: transfer.id,
        recipientId: recipient.id,
        quote: {
          id: quote.id,
          rate: transfer.rate,
          sourceAmount: transfer.sourceValue,
          targetAmount: transfer.targetValue,
          sourceCurrency: transfer.sourceCurrency,
          targetCurrency: transfer.targetCurrency,
          fee,
          estimatedDelivery,
        },
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wise.actions] initiatePayment error:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * STEP 2 — 4-Eyes confirmation: Fund the transfer.
 * Ledger posting is MANUAL — only occurs when both debitAccountId
 * and creditAccountId are provided by the user.
 */
export async function confirmPayment(
  payload: PaymentConfirmPayload
): Promise<
  | { ok: true; wiseStatus: string; journalEntryId?: string }
  | { ok: false; error: string }
> {
  try {
    const result = await WiseService.fundTransfer(
      payload.profileId,
      payload.transferId
    );

    if (result.errorCode) {
      return { ok: false, error: `Wise funding error: ${result.errorCode}` };
    }

    const updated = await WiseService.getTransfer(payload.transferId);

    await prisma.wiseTransfer.update({
      where: { wiseTransferId: payload.transferId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { status: mapWiseStatus(updated.status) as any },
    });


    let journalEntryId: string | null = null;
    const skipJournal = payload.debitAccountId === '__skip__' || !payload.debitAccountId || !payload.creditAccountId;

    // Optional ledger posting — only when the user has selected GL accounts
    if (!skipJournal) {
      const localTransfer = await prisma.wiseTransfer.findUnique({
        where: { wiseTransferId: payload.transferId },
      });

      if (localTransfer) {
        const { LedgerService } = await import('@/lib/ledger.service');
        const Decimal = (await import('decimal.js')).default;

        const entry = await LedgerService.postEntry({
          organizationId: payload.organizationId,
          date: new Date(),
          memo: `Wise Transfer #${payload.transferId} — ${localTransfer.recipientName ?? 'Recipient'}`,
          status: 'POSTED' as import('@/lib/types').JournalStatus,
          lines: [
            {
              accountId: payload.debitAccountId!,
              amount: new Decimal(localTransfer.sourceAmount),
              isDebit: true,
              memo: `Wise transfer debit — ${localTransfer.sourceCurrency}`,
            },
            {
              accountId: payload.creditAccountId!,
              amount: new Decimal(localTransfer.sourceAmount),
              isDebit: false,
              memo: `Wise transfer credit — ${localTransfer.sourceCurrency}`,
            },
          ],
        });

        journalEntryId = entry.id;

        await prisma.wiseTransfer.update({
          where: { wiseTransferId: payload.transferId },
          data: { journalEntryId: entry.id },
        });
      }
    }

    revalidatePath('/wise');
    return { ok: true, wiseStatus: updated.status, journalEntryId: journalEntryId ?? undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wise.actions] confirmPayment error:', msg);
    return { ok: false, error: msg };
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function getPaymentHistory(
  profileId: number
): Promise<
  | { ok: true; transfers: WiseTransferResponse[] }
  | { ok: false; error: string }
> {
  try {
    const transfers = await WiseService.listTransfers(profileId);
    return { ok: true, transfers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapWiseStatus(wiseStatus: string): string {
  const map: Record<string, string> = {
    incoming_payment_waiting: 'INCOMING_PAYMENT_WAITING',
    processing: 'PROCESSING',
    funds_converted: 'FUNDS_CONVERTED',
    outgoing_payment_sent: 'OUTGOING_PAYMENT_SENT',
    cancelled: 'CANCELLED',
    funds_refunded: 'FUNDS_REFUNDED',
    failed: 'FAILED',
  };
  return map[wiseStatus.toLowerCase()] ?? 'UNKNOWN';
}

// ─── Backwards-compat aliases for existing wise/page.tsx ─────────────────────
// The page uses these names; they delegate to the profile-aware functions above.
//** Resolve profileId: use caller-supplied id > env var > fetch default profile. */
async function resolveFirstProfileId(): Promise<number | null> {
  try {
    const profiles = await WiseService.getProfiles();
    return profiles[0]?.id ?? null;
  } catch {
    return null;
  }
}


export async function getWiseAccounts(): Promise<{ success: true; data: import('@/lib/wise.service').WiseBalance[] } | { success: false; error: string }> {
  try {
    const profileId = await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found. Check WISE_API_TOKEN.' };
    const balances = await WiseService.getBalances(profileId);
    return { success: true, data: balances as import('@/lib/wise.service').WiseBalance[] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}


export async function getWiseTransfers(): Promise<{ success: true; data: import('@/lib/wise.service').WiseTransferResult[] } | { success: false; error: string }> {
  try {
    const profileId = await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found.' };
    const transfers = await WiseService.listTransfers(profileId);
    return { success: true, data: transfers as import('@/lib/wise.service').WiseTransferResult[] };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}


export async function createWiseAccount(
  currency: string,
  callerProfileId?: number
): Promise<{ success: true; data: import('@/lib/wise.service').WiseBalance } | { success: false; error: string }> {
  try {
    if (!currency || currency.length !== 3) {
      return { success: false, error: 'Invalid currency code. Must be 3 letters (e.g. USD).' };
    }
    const profileId = callerProfileId ?? await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found.' };
    const balance = await WiseService.createBalance(profileId, currency);
    revalidatePath('/wise');
    return { success: true, data: balance as import('@/lib/wise.service').WiseBalance };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// getWiseProfiles compat (zero-arg) — handled by appended function below



// ─── Additional aliases for wise/payments/page.tsx ────────────────────────────

export async function getWiseQuote(
  sourceCurrency: string,
  targetCurrency: string,
  sourceAmount: number,
  callerProfileId?: number
): Promise<{ success: true; data: { rate: number; fee: number; targetAmount: number; estimatedDelivery: string; quoteId: string } } | { success: false; error: string }> {
  try {
    const profileId = callerProfileId ?? await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found.' };
    const quote = await WiseService.createQuote(profileId, sourceCurrency, targetCurrency, sourceAmount);
    const opt = quote.paymentOptions?.find((o) => o.payIn === 'BALANCE' && !o.disabled) ?? quote.paymentOptions?.[0];
    return {
      success: true,
      data: {
        rate: quote.rate,
        fee: opt?.fee?.total ?? 0,
        targetAmount: opt?.targetAmount ?? quote.targetAmount,
        estimatedDelivery: opt?.estimatedDelivery ?? '',
        quoteId: quote.id,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createWiseRecipient(details: {
  currency: string;
  type: string;
  accountHolderName: string;
  details: Record<string, string>;
}): Promise<{ success: true; data: { id: number } } | { success: false; error: string }> {
  try {
    const profileId = await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found.' };
    const recipient = await WiseService.createRecipient(profileId, {
      profileId,
      sourceCurrency: details.currency,
      targetCurrency: details.currency,
      sourceAmount: 0,
      recipientName: details.accountHolderName,
      iban: details.details['IBAN'],
      sortCode: details.details['sortCode'],
      accountNumber: details.details['accountNumber'],
    });
    return { success: true, data: { id: recipient.id } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function initiateWisePayment(payload: {
  quoteId: string;
  recipientId: number;
  reference?: string;
  debitAccountId: string;
  creditAccountId: string;
  organizationId: string;
  sourceAmount: number;
  sourceCurrency: string;
  targetCurrency: string;
  callerProfileId?: number;
}): Promise<{ success: true; data: { transferId: number; journalEntryId: string | null; status: string } } | { success: false; error: string }> {
  try {
    const profileId = payload.callerProfileId ?? await resolveFirstProfileId();
    if (!profileId) return { success: false, error: 'No Wise profile found.' };

    const transfer = await WiseService.createTransfer(payload.quoteId, payload.recipientId, payload.reference);
    const funded = await WiseService.fundTransfer(profileId, transfer.id);
    if (funded.errorCode) return { success: false, error: `Wise error: ${funded.errorCode}` };

    const updated = await WiseService.getTransfer(transfer.id);

    let journalEntryId: string | null = null;

    const skip = payload.debitAccountId === '__skip__' || payload.creditAccountId === '__skip__';
    if (!skip && payload.debitAccountId && payload.creditAccountId) {
      try {
        const { LedgerService } = await import('@/lib/ledger.service');
        const Decimal = (await import('decimal.js')).default;
        const entry = await LedgerService.postEntry({
          organizationId: payload.organizationId,
          date: new Date(),
          memo: `Wise Transfer #${transfer.id}`,
          status: 'POSTED' as import('@/lib/types').JournalStatus,
          lines: [
            { accountId: payload.debitAccountId, amount: new Decimal(payload.sourceAmount), isDebit: true },
            { accountId: payload.creditAccountId, amount: new Decimal(payload.sourceAmount), isDebit: false },
          ],
        });
        journalEntryId = entry.id;
      } catch {
        // Ledger posting failed silently — transfer still succeeded
      }
    }

    revalidatePath('/wise');
    return { success: true, data: { transferId: transfer.id, journalEntryId, status: updated.status } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
