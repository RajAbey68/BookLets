import { Decimal } from 'decimal.js';

export enum JournalStatus {
  DRAFT = 'DRAFT',
  POSTED = 'POSTED',
  VOIDED = 'VOIDED',
}

export interface JournalLineInput {
  accountId: string;
  amount: Decimal | number | string;
  isDebit: boolean;
  memo?: string;
}

export interface JournalEntryInput {
  organizationId: string;
  date: Date;
  memo?: string;
  status?: JournalStatus;
  lines: JournalLineInput[];
  // 4-Eyes governance metadata (optional — populated by automated agents)
  makerIdentity?: string;
  tenantId?: string;
  agentConfidence?: number;
  // RAJ-284 idempotency. Supply either a precomputed `idempotencyKey`, or a
  // `source` + `sourceId` pair from which the key is derived (recommended).
  idempotencyKey?: string;
  source?: string;
  sourceId?: string;
  // Optional discriminator so distinct entries derived from the same source
  // entity on one day (e.g. revenue vs a fee) get distinct idempotency keys.
  operation?: string;
}

export interface LedgerValidationResult {
  isValid: boolean;
  balance: Decimal;
  error?: string;
}
