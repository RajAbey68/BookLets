/**
 * RAJ-649 — CubeNote pure rules (four-eyes verify + input validation).
 *
 * The BI Cube Notes/Minutes layer records bookkeeping minutes, bad-debtor
 * flags, queries, and upload flags against the read-only accounting cube.
 * A note can be *verified* (checker sign-off) only by a DISTINCT identity —
 * the author can never verify their own note (four-eyes), mirroring the
 * approval.service.ts / EvidenceLog maker-checker pattern. Role is never an
 * input, so no caller can carve out an exemption.
 */
import { describe, it, expect } from 'vitest';
import {
  assertVerifierDistinct,
  parseCubeNoteInput,
  CUBE_NOTE_TAGS,
  SelfVerificationError,
  InvalidCubeNoteError,
} from '../../src/lib/cube-note.service';

describe('assertVerifierDistinct (four-eyes checker ≠ author)', () => {
  it('throws SelfVerificationError when author verifies their own note', () => {
    expect(() => assertVerifierDistinct('alice@ko.com', 'alice@ko.com')).toThrow(SelfVerificationError);
  });

  it('is case-insensitive: "Alice" cannot verify what "alice" authored', () => {
    expect(() => assertVerifierDistinct('Alice@Ko.com', 'alice@ko.com')).toThrow(SelfVerificationError);
  });

  it('is whitespace-insensitive: " alice " cannot verify "alice"', () => {
    expect(() => assertVerifierDistinct('alice@ko.com', ' alice@ko.com ')).toThrow(SelfVerificationError);
  });

  it('passes when author and verifier are distinct identities', () => {
    expect(() => assertVerifierDistinct('alice@ko.com', 'bob@ko.com')).not.toThrow();
  });

  it('requires a non-empty verifier even if the author is missing', () => {
    expect(() => assertVerifierDistinct(null, '')).toThrow(SelfVerificationError);
    expect(() => assertVerifierDistinct(null, '   ')).toThrow(SelfVerificationError);
    expect(() => assertVerifierDistinct(undefined, undefined)).toThrow(SelfVerificationError);
    expect(() => assertVerifierDistinct(null, 'bob@ko.com')).not.toThrow();
  });

  it('non-null author with empty verifier throws', () => {
    expect(() => assertVerifierDistinct('alice@ko.com', '')).toThrow(SelfVerificationError);
  });
});

describe('parseCubeNoteInput', () => {
  it('accepts a minimal valid note', () => {
    const result = parseCubeNoteInput({ content: 'Guest X still owes 3 nights', tag: 'BAD_DEBTOR' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Guest X still owes 3 nights');
      expect(result.value.tag).toBe('BAD_DEBTOR');
      expect(result.value.period).toBeNull();
      expect(result.value.uploadBatchId).toBeNull();
      expect(result.value.linkedRef).toBeNull();
    }
  });

  it('trims content and rejects empty/whitespace content', () => {
    expect(parseCubeNoteInput({ content: '   ', tag: 'MINUTE' }).ok).toBe(false);
    const trimmed = parseCubeNoteInput({ content: '  hi  ', tag: 'MINUTE' });
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) expect(trimmed.value.content).toBe('hi');
  });

  it('rejects an unknown tag', () => {
    const result = parseCubeNoteInput({ content: 'x', tag: 'NONSENSE' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tag/i);
  });

  it('accepts every documented tag', () => {
    for (const tag of CUBE_NOTE_TAGS) {
      expect(parseCubeNoteInput({ content: 'x', tag }).ok).toBe(true);
    }
  });

  it('validates period format (YYYY-MM) when supplied', () => {
    expect(parseCubeNoteInput({ content: 'x', tag: 'MINUTE', period: '2026-07' }).ok).toBe(true);
    expect(parseCubeNoteInput({ content: 'x', tag: 'MINUTE', period: '2026/07' }).ok).toBe(false);
    expect(parseCubeNoteInput({ content: 'x', tag: 'MINUTE', period: 'July' }).ok).toBe(false);
  });

  it('normalizes empty optional strings to null', () => {
    const result = parseCubeNoteInput({
      content: 'x',
      tag: 'QUERY',
      period: '',
      uploadBatchId: '  ',
      linkedRef: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.period).toBeNull();
      expect(result.value.uploadBatchId).toBeNull();
      expect(result.value.linkedRef).toBeNull();
    }
  });

  it('carries through uploadBatchId + linkedRef for UPLOAD_FLAG notes', () => {
    const result = parseCubeNoteInput({
      content: 'Duplicate invoice in extract',
      tag: 'UPLOAD_FLAG',
      uploadBatchId: 'batch-2026-07-01',
      linkedRef: 'cube-row-8842',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.uploadBatchId).toBe('batch-2026-07-01');
      expect(result.value.linkedRef).toBe('cube-row-8842');
    }
  });

  it('rejects a missing content field', () => {
    // @ts-expect-error deliberately malformed input
    expect(parseCubeNoteInput({ tag: 'MINUTE' }).ok).toBe(false);
  });

  it('surfaces InvalidCubeNoteError type for programmatic throw sites', () => {
    expect(new InvalidCubeNoteError('bad')).toBeInstanceOf(Error);
  });
});
