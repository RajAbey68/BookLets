import { listCubeNotes } from '@/app/actions/cube-note.actions';
import { loadCubeRows } from '@/lib/kolake-cube';
import CubeDashboard from '@/components/CubeDashboard';
import CubeNotesPanel from '@/components/CubeNotesPanel';

// Reads from the Ko Lake Supabase cube + BookLets DB; cannot be prerendered.
export const dynamic = 'force-dynamic';

type CubeNote = Awaited<ReturnType<typeof listCubeNotes>>[number];

export default async function BiCubePage() {
  const [cube, notes] = await Promise.all([loadCubeRows(), listCubeNotes({})]);

  const periods = [...new Set(notes.map((n: CubeNote) => n.period).filter((p): p is string => Boolean(p)))].sort();

  const noteViews = notes.map((n: CubeNote) => ({
    id: n.id,
    content: n.content,
    tag: n.tag,
    period: n.period,
    uploadBatchId: n.uploadBatchId,
    linkedRef: n.linkedRef,
    resolved: n.resolved,
    authorIdentity: n.authorIdentity,
    checkerIdentity: n.checkerIdentity,
    verifiedAt: n.verifiedAt,
    createdAt: n.createdAt,
  }));

  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: 600, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Business Intelligence
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>BI Cube</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Read-only Ko Lake accounting cube (scrap.cube_bi) with an internal Notes &amp; Minutes layer — bad debtors,
          bookkeeping minutes, queries, and flags on uploaded extracts (before QuickBooks Online).
        </p>
      </div>

      {/* ── Part 1: cube read dashboard ── */}
      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Cube query</h2>
      {cube.ok ? (
        <CubeDashboard rows={cube.rows} />
      ) : (
        <div className="glass-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Cube unavailable</div>
          <p style={{ fontSize: '0.875rem', margin: 0 }}>{cube.error}</p>
        </div>
      )}

      {/* ── Part 2: Notes / Minutes layer ── */}
      <h2 style={{ fontSize: '1.125rem', margin: '2.5rem 0 1rem' }}>Notes &amp; Minutes</h2>
      <CubeNotesPanel notes={noteViews} periods={periods} />
    </>
  );
}
