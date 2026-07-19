'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  assertVerifierDistinct,
  parseCubeNoteInput,
  SelfVerificationError,
  type CubeNoteTag,
  type RawCubeNoteInput,
} from '@/lib/cube-note.service';

export type CubeNoteResult = { success: true; id?: string } | { success: false; error: string };

export interface ListCubeNotesFilters {
  tag?: CubeNoteTag;
  period?: string;
  resolved?: boolean;
}

/**
 * RAJ-649 — list notes for the caller's organisation, optionally filtered by
 * tag / period / resolved. Org scope is always applied; a missing filter is
 * omitted from the where clause rather than matched against undefined.
 */
export async function listCubeNotes(filters: ListCubeNotesFilters) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  const where: Record<string, unknown> = { organizationId };
  if (filters.tag !== undefined) where.tag = filters.tag;
  if (filters.period !== undefined) where.period = filters.period;
  if (filters.resolved !== undefined) where.resolved = filters.resolved;

  try {
    return await prisma.cubeNote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  } catch (error) {
    console.error('[cube-note.actions] listCubeNotes failed:', error);
    return [];
  }
}

/**
 * RAJ-649 — create a note. The author identity comes from the SESSION
 * (resolveActiveContext), never from client input, so authorship cannot be
 * spoofed. Input is validated by the pure parser before any DB write.
 */
export async function createCubeNote(input: RawCubeNoteInput): Promise<CubeNoteResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;

  const parsed = parseCubeNoteInput(input);
  if (!parsed.ok) return { success: false, error: parsed.error };

  try {
    const note = await prisma.cubeNote.create({
      data: {
        content: parsed.value.content,
        tag: parsed.value.tag,
        period: parsed.value.period,
        uploadBatchId: parsed.value.uploadBatchId,
        linkedRef: parsed.value.linkedRef,
        resolved: false,
        authorIdentity: userId,
        organizationId,
      },
    });
    revalidatePath('/bi-cube');
    return { success: true, id: note.id };
  } catch (error) {
    console.error('[cube-note.actions] createCubeNote failed:', error);
    return { success: false, error: 'Failed to save the note. Try again shortly.' };
  }
}

/**
 * RAJ-649 — mark a note resolved. Org-scoped load + guarded update so a
 * cross-tenant id is indistinguishable from "not found".
 */
export async function resolveCubeNote(noteId: string): Promise<CubeNoteResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId } = resolved.context;

  let note;
  try {
    note = await prisma.cubeNote.findFirst({ where: { id: noteId, organizationId } });
  } catch (error) {
    console.error('[cube-note.actions] resolveCubeNote lookup failed:', error);
    return { success: false, error: 'Could not load the note. Try again shortly.' };
  }
  if (!note) return { success: false, error: 'Note not found.' };

  try {
    await prisma.cubeNote.updateMany({
      where: { id: noteId, organizationId },
      data: { resolved: true },
    });
    revalidatePath('/bi-cube');
    return { success: true };
  } catch (error) {
    console.error('[cube-note.actions] resolveCubeNote failed:', error);
    return { success: false, error: 'Failed to resolve the note.' };
  }
}

/**
 * RAJ-649 — checker sign-off (four-eyes). The verifier identity comes from the
 * session and MUST differ from the note's author — enforced even for OWNER
 * role (role never enters the check). The update is guarded on verifiedAt:null
 * so a concurrent double-verify loses cleanly instead of double-writing.
 */
export async function verifyCubeNote(noteId: string): Promise<CubeNoteResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;

  let note;
  try {
    note = await prisma.cubeNote.findFirst({ where: { id: noteId, organizationId } });
  } catch (error) {
    console.error('[cube-note.actions] verifyCubeNote lookup failed:', error);
    return { success: false, error: 'Could not load the note. Try again shortly.' };
  }
  if (!note) return { success: false, error: 'Note not found.' };

  try {
    assertVerifierDistinct(note.authorIdentity, userId);
  } catch (error) {
    if (error instanceof SelfVerificationError) {
      return { success: false, error: error.message };
    }
    throw error;
  }

  try {
    const updated = await prisma.cubeNote.updateMany({
      where: { id: noteId, organizationId, verifiedAt: null },
      data: { checkerIdentity: userId, verifiedAt: new Date() },
    });
    if (updated.count === 0) {
      return { success: false, error: 'This note was already verified by another checker.' };
    }
    revalidatePath('/bi-cube');
    return { success: true };
  } catch (error) {
    console.error('[cube-note.actions] verifyCubeNote failed:', error);
    return { success: false, error: 'Failed to verify the note.' };
  }
}
