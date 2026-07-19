/**
 * RAJ-649 — CubeNote pure rules (four-eyes verify + input validation).
 *
 * The BI Cube Notes/Minutes layer records bookkeeping minutes, bad-debtor
 * flags, queries, and upload flags against the read-only Ko Lake accounting
 * cube. These functions are the single authority for "is this note input
 * valid" and "may this identity verify this note". Role is deliberately NOT
 * an input — an OWNER who authored a note still cannot verify it, mirroring
 * approval.service.ts. No caller can add a role-based carve-out without
 * changing this file (and its tests).
 */

/** The four documented note tags. Kept in sync with the Prisma CubeNoteTag enum. */
export const CUBE_NOTE_TAGS = ['BAD_DEBTOR', 'UPLOAD_FLAG', 'QUERY', 'MINUTE'] as const;
export type CubeNoteTag = (typeof CUBE_NOTE_TAGS)[number];

/** Thrown when the verifier is the author — or is not a usable identity at all. */
export class SelfVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfVerificationError';
  }
}

/** Thrown when a note payload fails validation. */
export class InvalidCubeNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCubeNoteError';
  }
}

export interface RawCubeNoteInput {
  content: string;
  tag: string;
  period?: string | null;
  uploadBatchId?: string | null;
  linkedRef?: string | null;
}

export interface ParsedCubeNoteInput {
  content: string;
  tag: CubeNoteTag;
  period: string | null;
  uploadBatchId: string | null;
  linkedRef: string | null;
}

export type ParseResult =
  | { ok: true; value: ParsedCubeNoteInput }
  | { ok: false; error: string };

/**
 * Case- and whitespace-insensitive identity normalisation: "Alice " and
 * "alice" are the same human as far as four-eyes is concerned.
 */
function normalizeIdentity(identity: string | null | undefined): string {
  return (identity ?? '').trim().toLowerCase();
}

/**
 * Four-eyes: the verifier (checker) must be a distinct, non-empty identity
 * from the author (maker). A null/undefined author (legacy rows) does NOT
 * waive the rule — the verifier must still be a real, distinct identity.
 */
export function assertVerifierDistinct(
  authorIdentity: string | null | undefined,
  verifierIdentity: string | null | undefined,
): void {
  const verifier = normalizeIdentity(verifierIdentity);
  if (verifier === '') {
    throw new SelfVerificationError(
      'Verifier identity is missing. Four-eyes sign-off requires a signed-in, distinct verifier.',
    );
  }
  const author = normalizeIdentity(authorIdentity);
  if (author !== '' && author === verifier) {
    throw new SelfVerificationError(
      'Self-verification is not allowed: the verifier must be a different user than the author (four-eyes).',
    );
  }
}

/** YYYY-MM period, e.g. "2026-07". */
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function nullableTrim(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate + normalise a note payload from the client. Never trust the tag,
 * period, or optional refs — the client can send anything.
 */
export function parseCubeNoteInput(input: RawCubeNoteInput): ParseResult {
  if (!input || typeof input.content !== 'string') {
    return { ok: false, error: 'A note must have content.' };
  }
  const content = input.content.trim();
  if (content === '') {
    return { ok: false, error: 'A note cannot be empty.' };
  }
  if (!CUBE_NOTE_TAGS.includes(input.tag as CubeNoteTag)) {
    return { ok: false, error: `Unknown tag "${input.tag}". Must be one of ${CUBE_NOTE_TAGS.join(', ')}.` };
  }
  const period = nullableTrim(input.period);
  if (period !== null && !PERIOD_RE.test(period)) {
    return { ok: false, error: 'Period must be in YYYY-MM format, e.g. "2026-07".' };
  }
  return {
    ok: true,
    value: {
      content,
      tag: input.tag as CubeNoteTag,
      period,
      uploadBatchId: nullableTrim(input.uploadBatchId),
      linkedRef: nullableTrim(input.linkedRef),
    },
  };
}
