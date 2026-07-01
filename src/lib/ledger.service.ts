import { createHash } from 'crypto';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { EvidenceLogService } from './evidence-log.service';
import {
  JournalEntryInput,
  JournalStatus,
  LedgerValidationResult,
} from './types';

/**
 * RAJ-285 — thrown when a guarded update loses to a concurrent writer: the
 * row's version no longer matches the version the caller read, so the write
 * was rejected to prevent a lost update. Callers should re-read and retry.
 */
export class OptimisticLockError extends Error {
  readonly entryId: string;
  readonly expectedVersion: number;

  constructor(entryId: string, expectedVersion: number) {
    super(
      `Optimistic lock failed for JournalEntry "${entryId}": expected version ${expectedVersion}, ` +
        `but the entry was modified by another writer. Re-read the entry and retry.`
    );
    this.name = 'OptimisticLockError';
    this.entryId = entryId;
    this.expectedVersion = expectedVersion;
  }
}

export class LedgerService {
  /**
   * Validates that the sum of debits equals the sum of credits.
   * Debits are treated as positive and credits as negative for the zero-sum check.
   */
  static validateTrialBalance(lines: JournalEntryInput['lines']): LedgerValidationResult {
    if (lines.length < 2) {
      return { isValid: false, balance: new Decimal(0), error: 'A journal entry must have at least two lines.' };
    }

    let balance = new Decimal(0);
    for (const line of lines) {
      const amount = new Decimal(line.amount.toString());
      if (line.isDebit) {
        balance = balance.plus(amount);
      } else {
        balance = balance.minus(amount);
      }
    }

    if (!balance.isZero()) {
      return { 
        isValid: false, 
        balance, 
        error: `Journal entry is unbalanced. Trial balance difference: ${balance.toFixed(2)}` 
      };
    }

    return { isValid: true, balance };
  }

  /**
   * Checks if the given date falls within an open fiscal period for the organization.
   */
  static async checkFiscalPeriod(organizationId: string, date: Date): Promise<boolean> {
    const period = await prisma.fiscalPeriod.findFirst({
      where: {
        organizationId,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    });

    if (!period) {
      throw new Error(`No fiscal period defined for the date ${date.toLocaleDateString()}.`);
    }

    if (period.isClosed) {
      throw new Error(`The fiscal period "${period.name}" is closed. No new entries allowed.`);
    }

    return true;
  }

  /**
   * RAJ-284 — Deterministic idempotency key for a journal entry.
   *
   * key = sha256(organizationId ‖ source ‖ sourceId ‖ operation ‖ calendar-day).
   * The day is derived from the UTC date so time-of-day jitter on a retry does
   * not change the key. A NUL separator makes the concatenation unambiguous, so
   * ("a","bc") and ("ab","c") never collide.
   *
   * `organizationId` scopes the key per tenant — two orgs syncing the same
   * external id on the same day must NOT collide (N-02 multi-tenant isolation).
   * `operation` distinguishes genuinely different entries from the same source
   * entity on one day (e.g. a booking's revenue vs a separate fee), so a real
   * second transaction is not silently deduped. Both are optional, so existing
   * 3-arg callers keep working unchanged.
   */
  static computeIdempotencyKey(
    source: string,
    sourceId: string,
    date: Date,
    opts?: { organizationId?: string; operation?: string },
  ): string {
    const day = date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const material = [opts?.organizationId ?? '', source, sourceId, opts?.operation ?? '', day].join('\u0000');
    return createHash('sha256').update(material).digest('hex');
  }

  /** True when `err` is the unique-constraint violation on idempotencyKey. */
  private static isIdempotencyConflict(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }
    const target = (err.meta as { target?: string[] | string } | undefined)?.target;
    if (!target) return true; // no field info — assume it's ours (key is the only unique nullable field involved)
    return Array.isArray(target)
      ? target.includes('idempotencyKey')
      : target.includes('idempotencyKey');
  }

  /**
   * Posts a new Journal Entry atomically after validating the balance and fiscal period.
   *
   * Idempotent when an `idempotencyKey` (or `source` + `sourceId`) is supplied:
   * a duplicate POST returns the already-persisted entry instead of creating a
   * second one — both on the fast path (key already visible) and after losing a
   * concurrent race (unique-constraint P2002).
   */
  static async postEntry(input: JournalEntryInput) {
    const {
      organizationId,
      date,
      memo,
      status = JournalStatus.POSTED,
      lines,
      makerIdentity,
      tenantId,
      agentConfidence,
    } = input;

    // RAJ-284: explicit key wins; otherwise derive from source + sourceId.
    const idempotencyKey = input.idempotencyKey
      ?? (input.source && input.sourceId
        ? this.computeIdempotencyKey(input.source, input.sourceId, date, { organizationId, operation: input.operation })
        : undefined);

    // Fast path: this key already posted → return it, skipping validation and
    // the transaction entirely.
    if (idempotencyKey) {
      const existing = await prisma.journalEntry.findUnique({
        where: { idempotencyKey },
        include: { lines: true },
      });
      if (existing) return existing;
    }

    // 1. Strict Validation for POSTED entries
    if (status === JournalStatus.POSTED) {
      const validation = this.validateTrialBalance(lines);
      if (!validation.isValid) {
        throw new Error(`CRITICAL LEDGER ERROR: ${validation.error}`);
      }

      // Check for zero-amount lines (compliance)
      if (lines.some(l => new Decimal(l.amount.toString()).isZero())) {
        throw new Error('CRITICAL LEDGER ERROR: Journal entries cannot contain zero-amount lines.');
      }
    }

    // 2. Fiscal Period Check (Strict for all)
    await this.checkFiscalPeriod(organizationId, date);

    // 3. Atomic Transaction — entry + evidence row succeed or fail together.
    try {
      return await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          organizationId,
          date,
          memo,
          status,
          makerIdentity,
          tenantId,
          agentConfidence,
          idempotencyKey,
          lines: {
            create: lines.map(line => ({
              accountId: line.accountId,
              amount: new Decimal(line.amount.toString()), // keep as Decimal — do NOT call .toNumber() (loses precision)
              isDebit: line.isDebit,
            }))
          }
        },
        include: {
          lines: true,
        }
      });

      await EvidenceLogService.record(tx, {
        eventType: 'JOURNAL_POSTED',
        tenantId: tenantId ?? organizationId,
        makerIdentity: makerIdentity ?? 'system',
        description: `Journal entry posted${memo ? `: ${memo}` : ''}`,
        payload: {
          entryId: entry.id,
          organizationId,
          date: date.toISOString(),
          status,
          memo,
          agentConfidence,
          lines: entry.lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount.toString(),
            isDebit: l.isDebit,
          })),
        },
      });

      return entry;
      });
    } catch (err) {
      // Lost an idempotency race: a concurrent POST with the same key won and
      // tripped the unique constraint. The winner is now persisted — return it
      // rather than surfacing the conflict to the caller.
      if (idempotencyKey && this.isIdempotencyConflict(err)) {
        const existing = await prisma.journalEntry.findUnique({
          where: { idempotencyKey },
          include: { lines: true },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Reverses an existing Journal Entry by creating a new one with inverse debits/credits.
   *
   * `makerIdentity` is the actor performing the reversal. The EvidenceLog
   * records this — not the original entry's maker — because a reversal is a
   * distinct accounting act and the audit trail must attribute it correctly.
   * Falls back to the original entry's maker only when no actor is supplied
   * (e.g. legacy/system-initiated calls).
   */
  static async reverseEntry(entryId: string, reason: string, makerIdentity?: string): Promise<{ id: string }> {
    const originalEntry = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: true }
    });

    if (!originalEntry) {
      throw new Error('Journal Entry not found.');
    }

    if (originalEntry.status !== 'POSTED') {
      throw new Error(`Cannot reverse an entry with status "${originalEntry.status}". Only POSTED entries can be reversed.`);
    }

    // 1. Prepare reversed lines
    const reversedLines = originalEntry.lines.map(line => ({
      accountId: line.accountId,
      amount: new Decimal(line.amount),
      isDebit: !line.isDebit, // Flip Debit/Credit
      memo: `Reversal of Entry #${entryId}: ${reason}`
    }));

    // 2. Create the reversal entry
    return await prisma.$transaction(async (tx) => {
      const reversal = await tx.journalEntry.create({
        data: {
          organizationId: originalEntry.organizationId,
          date: new Date(),
          memo: `AUTO-REVERSAL: [Original Entry ID: ${entryId}] - Reason: ${reason}`,
          status: 'POSTED',
          lines: {
            create: reversedLines.map(line => ({
              accountId: line.accountId,
              amount: line.amount, // Decimal — do NOT call .toNumber() (loses precision)
              isDebit: line.isDebit,
            }))
          }
        },
        include: { lines: true }
      });

      // 3. Mark the original as VOIDED (or similar, but I'll update it to VOIDED here)
      // Note: My extension blocks delete, but update is allowed.
      await tx.journalEntry.update({
        where: { id: entryId },
        data: { status: 'VOIDED', memo: (originalEntry.memo || '') + ` | Reversed by ${reversal.id}` }
      });

      await EvidenceLogService.record(tx, {
        eventType: 'JOURNAL_REVERSED',
        tenantId: originalEntry.organizationId,
        makerIdentity: makerIdentity ?? originalEntry.makerIdentity ?? 'system',
        description: `Reversed entry ${entryId}: ${reason}`,
        payload: {
          reversalId: reversal.id,
          originalEntryId: entryId,
          reason,
        },
      });

      return reversal;
    });
  }

  /**
   * RAJ-285 — Update a JournalEntry under optimistic concurrency control.
   *
   * The caller passes the `expectedVersion` it read. The update only applies
   * when the row still has that version, and it atomically increments the
   * version. A stale write matches zero rows (`count === 0`) and raises
   * OptimisticLockError instead of silently clobbering a concurrent change.
   *
   * `version` is stripped from `data` so a caller can never pin it — the
   * counter is owned entirely by this method.
   */
  static async updateEntryWithVersion(
    id: string,
    expectedVersion: number,
    data: Omit<Prisma.JournalEntryUpdateInput, 'version'>,
  ) {
    // Strip any caller-supplied version — the counter is owned by this method.
    const safeData = { ...(data as Prisma.JournalEntryUpdateInput) };
    delete safeData.version;

    const result = await prisma.journalEntry.updateMany({
      where: { id, version: expectedVersion },
      data: { ...safeData, version: { increment: 1 } },
    });

    if (result.count === 0) {
      throw new OptimisticLockError(id, expectedVersion);
    }

    return prisma.journalEntry.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    });
  }

  /**
   * Utility to compute account balances for an organization.
   */
  static async getAccountBalance(accountId: string): Promise<Decimal> {
    const lines = await prisma.journalLine.findMany({
      where: { 
        accountId,
        journalEntry: { status: 'POSTED' } 
      }
    });

    return lines.reduce(
      (acc, curr) => curr.isDebit 
        ? acc.plus(new Decimal(curr.amount)) 
        : acc.minus(new Decimal(curr.amount)), 
      new Decimal(0)
    );
  }
}
