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

// ─── Wise API Types ──────────────────────────────────────────────────────────

export interface WiseApiProfile {
  id: number;
  type: 'personal' | 'business';
  details: {
    firstName?: string;
    lastName?: string;
    name?: string;
    dateOfBirth?: string;
    phoneNumber?: string;
    avatar?: string;
    occupation?: string;
    primaryAddress?: number;
    companyNumber?: string;
    companyType?: string;
    webpage?: string;
  };
}

export interface WiseBalance {
  id: number;
  balanceType: 'STANDARD' | 'SAVINGS';
  currency: string;
  amount: {
    value: number;
    currency: string;
  };
  reservedAmount: {
    value: number;
    currency: string;
  };
  bankDetails: null | {
    id: number;
    currency: string;
    bankCode: string;
    accountNumber: string;
    swift: string;
    iban: string;
    bankName: string;
    accountHolderName: string;
    bankAddress: {
      addressFirstLine: string;
      postCode: string;
      city: string;
      country: string;
      stateCode: string;
    };
  };
  investmentState: 'NOT_INVESTED' | string;
  creationTime: string;
  modificationTime: string;
  visible: boolean;
}

export interface WiseQuote {
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  targetAmount: number;
  rate: number;
  createdTime: string;
  expirationTime: string;
  paymentOptions: WisePaymentOption[];
  status: 'PENDING' | 'ACCEPTED' | 'FUNDED' | 'EXPIRED';
  notices: { text: string; link: string | null; type: string }[];
}

export interface WisePaymentOption {
  disabled: boolean;
  estimatedDelivery: string;
  formattedEstimatedDelivery: string;
  estimatedDeliveryDelays: string[];
  fee: { transferwise: number; payIn: number; discount: number; total: number; priceSetId: number; partner: number };
  price: { total: { type: string; label: string; value: { amount: number; currency: string; label: string } } };
  sourceAmount: number;
  targetAmount: number;
  sourceCurrency: string;
  targetCurrency: string;
  payIn: string;
  payOut: string;
  allowedProfileTypes: string[];
  payInProduct: string;
  feePercentage: number;
}

export interface WiseRecipientAccount {
  id: number;
  profile: number;
  accountHolderName: string;
  currency: string;
  country: string;
  type: string;
  details: Record<string, unknown>;
}

export interface WiseTransferResponse {
  id: number;
  user: number;
  targetAccount: number;
  sourceAccount: number | null;
  quote: string;
  quoteUuid: string;
  status: string;
  reference: string;
  rate: number;
  created: string;
  business: number;
  transferRequest: number | null;
  details: { reference: string; transferPurpose: string; sourceOfFunds: string };
  hasActiveIssues: boolean;
  sourceCurrency: string;
  sourceValue: number;
  targetCurrency: string;
  targetValue: number;
  customerTransactionId: string;
}

export interface PaymentInitiatePayload {
  profileId: number;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  recipientName: string;
  recipientEmail?: string;
  iban?: string;
  accountNumber?: string;
  sortCode?: string;
  bankCode?: string;
  reference?: string;
}

export interface PaymentConfirmPayload {
  transferId: number;
  localTransferId: string;
  profileId: number;
  organizationId: string;
  // For ledger auto-posting
  debitAccountId?: string;   // e.g. Accounts Payable GL account
  creditAccountId?: string;  // e.g. Wise Bank GL account
}
