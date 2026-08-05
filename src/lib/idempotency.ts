import crypto from 'crypto';

/**
 * Compute a deterministic SHA256 hash for idempotent journal entry posting.
 * Used to prevent double-posting when spreadsheet uploads are retried.
 *
 * Input should be stable and deterministic:
 * - sandboxSessionId: Unique identifier of the upload session
 * - amount: Total amount being posted (as string, after Decimal conversion)
 * - date: ISO date string (YYYY-MM-DD)
 * - description: Transaction description
 *
 * @returns SHA256 hex digest
 */
export function computeSourceHash(input: {
  sandboxSessionId?: string;
  amount: string;
  date: string; // ISO date YYYY-MM-DD
  description: string;
}): string {
  const payload = JSON.stringify({
    sandboxSessionId: input.sandboxSessionId || '',
    amount: input.amount,
    date: input.date,
    description: input.description,
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Verify idempotency: check if an entry with this sourceHash already exists.
 * If it does, the posting is considered idempotent (already completed).
 *
 * This is a helper for application logic; the database UNIQUE constraint
 * is the authoritative enforcement.
 */
export async function isAlreadyPosted(sourceHash: string, prisma: any): Promise<boolean> {
  const existing = await prisma.journalEntry.findUnique({
    where: { sourceHash },
    select: { id: true },
  });
  return !!existing;
}
