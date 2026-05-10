import { createHash } from 'node:crypto';

export interface EvidenceLogInput {
  eventType: string;
  tenantId: string;
  makerIdentity: string;
  description: string;
  payload: Record<string, unknown>;
  checkerIdentity?: string;
}

/**
 * Minimal client surface so the service can accept either the extended
 * Prisma client or the transaction-scoped client without dragging the
 * Prisma 7 generated types through the public signature.
 *
 * `any` is required (instead of `unknown`) on the args because Prisma's
 * generated method signatures use generic narrow types; a parameter
 * typed `unknown` would be contravariantly incompatible and reject the
 * Prisma client at the call site.
 */
interface EvidenceLogClient {
  evidenceLog: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: (args: any) => Promise<{ hash: string } | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args: any) => Promise<{
      id: string;
      hash: string;
      previousHash: string | null;
    }>;
  };
}

export class EvidenceLogService {
  /**
   * Records an immutable evidence row, chained to the previous evidence
   * for the same tenant via sha256(previousHash || canonical(payload) || ...).
   *
   * Must be called inside the same transaction as the operation it
   * witnesses, so the evidence cannot exist without the operation
   * (and vice versa).
   *
   * Concurrency caveat: under concurrent writers for the same tenantId
   * the chain can fork (two writers may both read the same previousHash).
   * Mitigation via advisory locks or SELECT ... FOR UPDATE is tracked as
   * a followup in AGENTS_LOG.md.
   */
  static async record(tx: EvidenceLogClient, input: EvidenceLogInput) {
    const previous = await tx.evidenceLog.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });
    const previousHash = previous?.hash ?? null;
    const createdAt = new Date();

    const hash = computeHash({
      previousHash,
      eventType: input.eventType,
      tenantId: input.tenantId,
      makerIdentity: input.makerIdentity,
      payload: input.payload,
      createdAt,
    });

    return tx.evidenceLog.create({
      data: {
        eventType: input.eventType,
        tenantId: input.tenantId,
        makerIdentity: input.makerIdentity,
        checkerIdentity: input.checkerIdentity,
        description: input.description,
        payload: input.payload,
        hash,
        previousHash,
        createdAt,
      },
    });
  }

  /**
   * Re-derives the hash for an evidence row and compares to the stored
   * value. Used by audit/verification jobs to detect tampering.
   */
  static verify(row: {
    previousHash: string | null;
    eventType: string;
    tenantId: string;
    makerIdentity: string;
    payload: unknown;
    createdAt: Date;
    hash: string;
  }): boolean {
    return computeHash(row) === row.hash;
  }
}

interface HashInput {
  previousHash: string | null;
  eventType: string;
  tenantId: string;
  makerIdentity: string;
  payload: unknown;
  createdAt: Date;
}

function computeHash(h: HashInput): string {
  const parts = [
    h.previousHash ?? '',
    h.eventType,
    h.tenantId,
    h.makerIdentity,
    canonicalize(h.payload),
    h.createdAt.toISOString(),
  ].join('|');
  return createHash('sha256').update(parts).digest('hex');
}

/**
 * Stable JSON serialisation with sorted keys so semantically equivalent
 * payloads produce identical hashes regardless of property insertion
 * order. Avoids pulling in a stringify dependency.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize(obj[k]),
  );
  return '{' + entries.join(',') + '}';
}
