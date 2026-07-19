/**
 * RAJ-649 — CubeNote server actions (mocked Prisma, style of
 * approval-actions.test.ts).
 *
 * Invariants under test:
 *  - the author/verifier identity is resolved from the SESSION
 *    (resolveActiveContext), never from client input;
 *  - unauthenticated callers cannot create, list, resolve, or verify;
 *  - verify enforces four-eyes: the verifier must be a DISTINCT identity
 *    from the note's author — even for OWNER role (role never enters the check);
 *  - verify is a guarded update (where includes verifiedAt: null) so a
 *    concurrent double-verify loses cleanly;
 *  - list filters (tag/period/resolved) are passed through org-scoped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type AnyRecord = Record<string, unknown>;

const existingNote = {
  id: 'note-1',
  content: 'Guest A owes 2 nights',
  tag: 'BAD_DEBTOR',
  period: '2026-07',
  uploadBatchId: null,
  linkedRef: null,
  resolved: false,
  authorIdentity: 'maker@ko.com',
  checkerIdentity: null,
  verifiedAt: null,
  organizationId: 'org-1',
  createdAt: new Date('2026-07-01T10:00:00Z'),
  updatedAt: new Date('2026-07-01T10:00:00Z'),
};

interface SetupOverrides {
  userId?: string;
  note?: AnyRecord | null;
  verifyUpdateCount?: number;
  resolveUpdateCount?: number;
  unauthenticated?: boolean;
}

function setup(overrides: SetupOverrides = {}) {
  const prisma = {
    cubeNote: {
      create: vi.fn().mockResolvedValue({ ...existingNote, id: 'note-new' }),
      findMany: vi.fn().mockResolvedValue([existingNote]),
      findFirst: vi.fn().mockResolvedValue(
        overrides.note === undefined ? existingNote : overrides.note,
      ),
      updateMany: vi.fn().mockImplementation((args: { data: AnyRecord }) => {
        if ('verifiedAt' in args.data || 'checkerIdentity' in args.data) {
          return Promise.resolve({ count: overrides.verifyUpdateCount ?? 1 });
        }
        return Promise.resolve({ count: overrides.resolveUpdateCount ?? 1 });
      }),
    },
  };

  vi.doMock('../../src/lib/prisma', () => ({ prisma }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: {
              organizationId: 'org-1',
              organizationName: 'Ko Lake',
              userId: overrides.userId ?? 'checker@ko.com',
              role: 'OWNER', // OWNER on purpose — role must NOT bypass four-eyes
            },
          },
    ),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));

  return { prisma };
}

async function importActions() {
  return import('../../src/app/actions/cube-note.actions');
}

beforeEach(() => vi.resetModules());

describe('createCubeNote', () => {
  it('rejects an unauthenticated caller', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { createCubeNote } = await importActions();
    const result = await createCubeNote({ content: 'x', tag: 'MINUTE' });
    expect(result.success).toBe(false);
    expect(prisma.cubeNote.create).not.toHaveBeenCalled();
  });

  it('rejects invalid input before touching the DB', async () => {
    const { prisma } = setup();
    const { createCubeNote } = await importActions();
    const result = await createCubeNote({ content: '   ', tag: 'MINUTE' });
    expect(result.success).toBe(false);
    expect(prisma.cubeNote.create).not.toHaveBeenCalled();
  });

  it('stores the session identity as author (never client input) + org scope', async () => {
    const { prisma } = setup({ userId: 'author@ko.com' });
    const { createCubeNote } = await importActions();
    const result = await createCubeNote({ content: 'Flag on extract', tag: 'UPLOAD_FLAG', uploadBatchId: 'b-1' });
    expect(result.success).toBe(true);
    expect(prisma.cubeNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          authorIdentity: 'author@ko.com',
          organizationId: 'org-1',
          tag: 'UPLOAD_FLAG',
          uploadBatchId: 'b-1',
          resolved: false,
        }),
      }),
    );
  });
});

describe('listCubeNotes', () => {
  it('returns [] when unauthenticated', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { listCubeNotes } = await importActions();
    expect(await listCubeNotes({})).toEqual([]);
    expect(prisma.cubeNote.findMany).not.toHaveBeenCalled();
  });

  it('filters by tag/period/resolved, org-scoped', async () => {
    const { prisma } = setup();
    const { listCubeNotes } = await importActions();
    await listCubeNotes({ tag: 'BAD_DEBTOR', period: '2026-07', resolved: false });
    expect(prisma.cubeNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          tag: 'BAD_DEBTOR',
          period: '2026-07',
          resolved: false,
        }),
      }),
    );
  });

  it('omits undefined filters from the where clause', async () => {
    const { prisma } = setup();
    const { listCubeNotes } = await importActions();
    await listCubeNotes({});
    const call = prisma.cubeNote.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ organizationId: 'org-1' });
  });
});

describe('resolveCubeNote', () => {
  it('marks a note resolved, org-scoped and guarded', async () => {
    const { prisma } = setup();
    const { resolveCubeNote } = await importActions();
    const result = await resolveCubeNote('note-1');
    expect(result.success).toBe(true);
    expect(prisma.cubeNote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'note-1', organizationId: 'org-1' }),
        data: expect.objectContaining({ resolved: true }),
      }),
    );
  });

  it('is not found for a cross-tenant note id', async () => {
    const { prisma } = setup({ note: null });
    const { resolveCubeNote } = await importActions();
    const result = await resolveCubeNote('note-x');
    expect(result.success).toBe(false);
    expect(prisma.cubeNote.updateMany).not.toHaveBeenCalled();
  });
});

describe('verifyCubeNote (four-eyes checker ≠ author)', () => {
  it('blocks self-verification even for OWNER role', async () => {
    const { prisma } = setup({ userId: 'maker@ko.com' }); // verifier === author
    const { verifyCubeNote } = await importActions();
    const result = await verifyCubeNote('note-1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/self|different|four/i);
    expect(prisma.cubeNote.updateMany).not.toHaveBeenCalled();
  });

  it('allows a distinct verifier: guarded update stamps checker + verifiedAt', async () => {
    const { prisma } = setup({ userId: 'checker@ko.com' });
    const { verifyCubeNote } = await importActions();
    const result = await verifyCubeNote('note-1');
    expect(result.success).toBe(true);
    expect(prisma.cubeNote.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'note-1', organizationId: 'org-1', verifiedAt: null }),
        data: expect.objectContaining({ checkerIdentity: 'checker@ko.com' }),
      }),
    );
    const data = prisma.cubeNote.updateMany.mock.calls[0][0].data;
    expect(data.verifiedAt).toBeInstanceOf(Date);
  });

  it('fails cleanly when the note was already verified (guarded update count 0)', async () => {
    // note already verified -> guarded update matches nothing
    setup({
      note: { ...existingNote, verifiedAt: new Date() },
      verifyUpdateCount: 0,
    });
    const { verifyCubeNote } = await importActions();
    const result = await verifyCubeNote('note-1');
    expect(result.success).toBe(false);
  });

  it('is not found for a cross-tenant note id', async () => {
    const { prisma } = setup({ note: null });
    const { verifyCubeNote } = await importActions();
    const result = await verifyCubeNote('note-x');
    expect(result.success).toBe(false);
    expect(prisma.cubeNote.updateMany).not.toHaveBeenCalled();
  });
});
