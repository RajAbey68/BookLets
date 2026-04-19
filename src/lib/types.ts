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
}

export interface LedgerValidationResult {
  isValid: boolean;
  balance: Decimal;
  error?: string;
}
