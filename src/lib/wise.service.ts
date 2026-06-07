/**
 * wise.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Encapsulates all Wise Platform API calls.
 * Uses the API token from WISE_API_TOKEN env var.
 * Sandbox:    https://api.sandbox.transferwise.tech
 * Production: https://api.wise.com
 *
 * Auth: Bearer token (Personal API token or SCA OAuth token)
 *
 * Docs: https://docs.wise.com/api-docs
 */

import {
  WiseApiProfile,
  WiseBalance,
  WiseQuote,
  WiseRecipientAccount,
  WiseTransferResponse,
  PaymentInitiatePayload,
} from './types';


// ─── Base Configuration ──────────────────────────────────────────────────────

function getBaseUrl(): string {
  const env = process.env.WISE_ENV ?? 'sandbox';
  return env === 'production'
    ? 'https://api.wise.com'
    : 'https://api.sandbox.transferwise.tech';
}

function getToken(): string {
  const token = process.env.WISE_API_TOKEN;
  if (!token) {
    throw new Error(
      '[WiseService] WISE_API_TOKEN is not set. Please add it to .env.local.'
    );
  }
  return token;
}

async function wiseRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const token = getToken();

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `[WiseService] ${options.method ?? 'GET'} ${path} → HTTP ${res.status}: ${body}`
    );
  }

  // 204 No Content (e.g. fund transfer confirmation)
  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

// ─── Profiles ────────────────────────────────────────────────────────────────

/**
 * Returns all profiles associated with the API token (personal + business).
 */
export async function getProfiles(): Promise<WiseApiProfile[]> {
  return wiseRequest<WiseApiProfile[]>('/v2/profiles');
}

// ─── Balances ────────────────────────────────────────────────────────────────

/**
 * Lists all balance accounts for a given Wise profile.
 * Only STANDARD and SAVINGS types are returned.
 */
export async function getBalances(profileId: number): Promise<WiseBalance[]> {
  return wiseRequest<WiseBalance[]>(
    `/v4/profiles/${profileId}/balances?types=STANDARD,SAVINGS`
  );
}

/**
 * Creates a new STANDARD balance account in the given currency.
 */
export async function createBalance(
  profileId: number,
  currency: string
): Promise<WiseBalance> {
  return wiseRequest<WiseBalance>(`/v4/profiles/${profileId}/balances`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'STANDARD',
      currency,
    }),
  });
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

/**
 * Creates a quote for a transfer. Returns live exchange rate + fee breakdown.
 * The quote ID is needed to create the transfer.
 */
export async function createQuote(
  profileId: number,
  sourceCurrency: string,
  targetCurrency: string,
  sourceAmount: number
): Promise<WiseQuote> {
  return wiseRequest<WiseQuote>(`/v3/profiles/${profileId}/quotes`, {
    method: 'POST',
    body: JSON.stringify({
      sourceCurrency,
      targetCurrency,
      sourceAmount,
      targetAmount: null,
      payOut: 'BANK_TRANSFER',
      preferredPayIn: 'BALANCE',
    }),
  });
}

// ─── Recipients ──────────────────────────────────────────────────────────────

/**
 * Creates a recipient account (the entity that will receive funds).
 * Supports IBAN-based (EU) and sort-code-based (UK) accounts.
 */
export async function createRecipient(
  profileId: number,
  payload: PaymentInitiatePayload
): Promise<WiseRecipientAccount> {
  let type = 'email';
  const details: Record<string, unknown> = {
    email: payload.recipientEmail,
  };

  if (payload.iban) {
    type = 'iban';
    Object.assign(details, { iban: payload.iban, legalType: 'PRIVATE' });
  } else if (payload.sortCode && payload.accountNumber) {
    type = 'sort_code';
    Object.assign(details, {
      sortCode: payload.sortCode,
      accountNumber: payload.accountNumber,
      legalType: 'PRIVATE',
    });
  }

  return wiseRequest<WiseRecipientAccount>('/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({
      profile: profileId,
      accountHolderName: payload.recipientName,
      currency: payload.targetCurrency,
      type,
      details,
    }),
  });
}

// ─── Transfers ───────────────────────────────────────────────────────────────

/**
 * Creates a transfer (does NOT fund it yet — call fundTransfer to execute).
 */
export async function createTransfer(
  quoteId: string,
  targetAccountId: number,
  reference?: string
): Promise<WiseTransferResponse> {
  return wiseRequest<WiseTransferResponse>('/v1/transfers', {
    method: 'POST',
    body: JSON.stringify({
      targetAccount: targetAccountId,
      quoteUuid: quoteId,
      customerTransactionId: `booklets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      details: {
        reference: reference ?? 'BookLets Payment',
        transferPurpose: 'verification.transfers.purpose.pay.bills',
        sourceOfFunds: 'verification.source.of.funds.business',
      },
    }),
  });
}

/**
 * Funds (executes) a previously created transfer.
 * ⚠️  This moves real money in production. Guarded by 4-Eyes gate in actions.
 */
export async function fundTransfer(
  profileId: number,
  transferId: number
): Promise<{ type: string; status: string; errorCode: string | null }> {
  return wiseRequest<{ type: string; status: string; errorCode: string | null }>(
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    {
      method: 'POST',
      body: JSON.stringify({ type: 'BALANCE' }),
    }
  );
}

/**
 * Gets the current status of a transfer.
 */
export async function getTransfer(
  transferId: number
): Promise<WiseTransferResponse> {
  return wiseRequest<WiseTransferResponse>(`/v1/transfers/${transferId}`);
}

/**
 * Lists recent transfers for a profile (last 100).
 */
export async function listTransfers(
  profileId: number
): Promise<WiseTransferResponse[]> {
  return wiseRequest<WiseTransferResponse[]>(
    `/v1/transfers?profile=${profileId}&limit=100`
  );
}

// ─── Exported namespace ──────────────────────────────────────────────────────

export const WiseService = {
  getProfiles,
  getBalances,
  createBalance,
  createQuote,
  createRecipient,
  createTransfer,
  fundTransfer,
  getTransfer,
  listTransfers,
};

// ─── Type re-exports for backwards-compat with existing wise/page.tsx ─────────
// WiseBalance is the canonical type from @/lib/types — re-exported so the UI
// pages can import it from here without changing their import path.
export type { WiseBalance } from './types';

/** Shape used by the existing UI page for a transfer result (simplified). */
export type WiseTransferResult = {
  id: number;
  sourceCurrency: string;
  targetCurrency: string;
  sourceValue: number;
  targetValue: number;
  status: string;
  rate: number;
  created: string;
  details: { reference: string; transferPurpose: string; sourceOfFunds: string };
  hasActiveIssues: boolean;
};

/** WiseProfile type alias for use in payments page. */
export type WiseProfile = WiseApiProfile;
