/**
 * S11 sandbox — the read-only staging-pile summary.
 *
 *  - summarizeOcrStaging (ocr-bridge.deps.ts): maps the one counts query onto
 *    the OcrStagingSummary shape — park reasons in classifyStagingRow
 *    precedence order, zero buckets omitted, totals reconciling — and issues
 *    a SELECT-only query against raj_fin_track (never a write);
 *  - degraded mode: a failing query (missing table/grant/DB, e.g. local dev)
 *    yields { available: false } instead of throwing — the /sandbox page must
 *    render its "staging unavailable" note, not crash;
 *  - fetchOcrStagingSummary (sandbox.actions.ts): bound to the same
 *    OCR_BRIDGE_ORG_ID gate as the bridge route — unset env or a mismatched
 *    org returns "unavailable" WITHOUT touching the staging schema.
 *
 * Mocked Prisma via vi.doMock in the style of ocr-bridge-deps.test.ts — no
 * database, no OCR.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORG = 'org-bridge';

/** A Prisma.sql fragment, duck-typed (Prisma.Sql is not constructable here). */
function isSqlFragment(v: unknown): v is { strings: string[]; values: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { strings?: unknown }).strings) &&
    Array.isArray((v as { values?: unknown }).values)
  );
}

/** Flatten a $queryRaw tagged-template call (nested Prisma.sql included) to text. */
function flattenSql(strings: readonly string[], values: readonly unknown[]): string {
  return strings.reduce((acc, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const rendered = isSqlFragment(v) ? flattenSql(v.strings, v.values) : '?';
    return `${acc}${rendered}${s}`;
  }, '');
}

interface SetupOverrides {
  countsRow?: Record<string, number>;
  queryError?: boolean;
}

/** Counts that reconcile: total = imported + importable + Σparked. */
const HEALTHY_COUNTS = {
  total: 10,
  already_imported: 3,
  importable: 4,
  ocr_failed: 1,
  bad_amount: 0,
  no_doc_date: 1,
  fx_unsupported: 0,
  no_fiscal_period: 1,
};

function setup(overrides: SetupOverrides = {}) {
  const queryTexts: string[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queryTexts.push(flattenSql(strings, values));
    if (overrides.queryError) {
      throw new Error('relation "raj_fin_track.ocr_receipts" does not exist');
    }
    return [overrides.countsRow ?? HEALTHY_COUNTS];
  });
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { $queryRaw },
    setRlsOrgContext: vi.fn(),
  }));
  // The deps module imports LedgerService; stub it so any reach-through from
  // a read-only summary fails the test loudly.
  vi.doMock('../../src/lib/ledger.service', () => ({
    LedgerService: {
      postEntryWithOutcome: vi.fn(async () => {
        throw new Error('summarizeOcrStaging must never post entries');
      }),
    },
  }));
  return { $queryRaw, queryTexts };
}

beforeEach(() => vi.resetModules());

// ─── summarizeOcrStaging (ocr-bridge.deps.ts) ────────────────────────────────

describe('summarizeOcrStaging', () => {
  it('maps the counts row onto the summary with park reasons in classification precedence, zero buckets omitted', async () => {
    setup();
    const { summarizeOcrStaging } = await import('../../src/lib/ocr-bridge.deps');

    const summary = await summarizeOcrStaging(ORG);

    expect(summary).toEqual({
      available: true,
      importable: 4,
      parked: [
        { reason: 'OCR_FAILED', count: 1 },
        { reason: 'NO_DOC_DATE', count: 1 },
        { reason: 'NO_FISCAL_PERIOD', count: 1 },
      ],
      alreadyImported: 3,
      total: 10,
    });
    // The summary reconciles exactly like a bridge run would.
    const parkedTotal = summary.parked.reduce((acc, p) => acc + p.count, 0);
    expect(summary.alreadyImported + summary.importable + parkedTotal).toBe(summary.total);
  });

  it('lists every nonzero park reason with its plain-English mapping available', async () => {
    setup({
      countsRow: {
        total: 5,
        already_imported: 0,
        importable: 0,
        ocr_failed: 1,
        bad_amount: 1,
        no_doc_date: 1,
        fx_unsupported: 1,
        no_fiscal_period: 1,
      },
    });
    const { summarizeOcrStaging } = await import('../../src/lib/ocr-bridge.deps');
    const { PARK_REASON_LABELS, parkReasonLabel } = await import(
      '../../src/lib/park-reason-labels'
    );

    const summary = await summarizeOcrStaging(ORG);

    expect(summary.parked.map((p) => p.reason)).toEqual([
      'OCR_FAILED',
      'BAD_AMOUNT',
      'NO_DOC_DATE',
      'FX_UNSUPPORTED',
      'NO_FISCAL_PERIOD',
    ]);
    // Every reason the summary can emit has a plain-English label for the UI.
    for (const { reason } of summary.parked) {
      expect(parkReasonLabel(reason)).toBe(PARK_REASON_LABELS[reason]);
      expect(parkReasonLabel(reason)).not.toBe(reason);
    }
    expect(parkReasonLabel('NO_DOC_DATE')).toBe('no date on receipt');
    expect(parkReasonLabel('NO_FISCAL_PERIOD')).toBe('date outside an open accounting year');
  });

  it('issues exactly one SELECT against the staging schema — read-only, org-scoped subqueries', async () => {
    const { queryTexts } = setup();
    const { summarizeOcrStaging } = await import('../../src/lib/ocr-bridge.deps');

    await summarizeOcrStaging(ORG);

    expect(queryTexts).toHaveLength(1);
    const sql = queryTexts[0];
    expect(sql).toContain('FROM raj_fin_track.ocr_receipts r');
    // NEVER write to raj_fin_track — the staging schema is foreign territory.
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|ALTER/i);
    // Reuses the bridge's org-scoped fragments (imported + fiscal period).
    expect(sql).toContain('"JournalEntry"');
    expect(sql).toContain('"FiscalPeriod"');
  });

  it('degrades to available: false instead of throwing when the staging table/grant/DB is absent', async () => {
    setup({ queryError: true });
    const { summarizeOcrStaging } = await import('../../src/lib/ocr-bridge.deps');

    const summary = await summarizeOcrStaging(ORG);

    expect(summary).toEqual({
      available: false,
      importable: 0,
      parked: [],
      alreadyImported: 0,
      total: 0,
    });
  });
});

// ─── fetchOcrStagingSummary (sandbox.actions.ts) — org binding ───────────────

describe('fetchOcrStagingSummary', () => {
  const envBefore = process.env.OCR_BRIDGE_ORG_ID;

  afterEach(() => {
    if (envBefore === undefined) delete process.env.OCR_BRIDGE_ORG_ID;
    else process.env.OCR_BRIDGE_ORG_ID = envBefore;
  });

  function mockAuth(overrides: { unauthenticated?: boolean; organizationId?: string } = {}) {
    vi.doMock('../../src/lib/auth-context', () => ({
      resolveActiveContext: vi.fn().mockResolvedValue(
        overrides.unauthenticated
          ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
          : {
              ok: true,
              context: {
                organizationId: overrides.organizationId ?? ORG,
                organizationName: 'Test Org',
                userId: 'user-1',
                role: 'OWNER',
              },
            },
      ),
    }));
  }

  it('returns the staging summary for the one configured bridge org', async () => {
    const { $queryRaw } = setup();
    mockAuth();
    process.env.OCR_BRIDGE_ORG_ID = ORG;
    const { fetchOcrStagingSummary } = await import('../../src/app/actions/sandbox.actions');

    const summary = await fetchOcrStagingSummary();

    expect(summary.available).toBe(true);
    expect(summary.total).toBe(10);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable WITHOUT querying staging when OCR_BRIDGE_ORG_ID is unset (e.g. local dev)', async () => {
    const { $queryRaw } = setup();
    mockAuth();
    delete process.env.OCR_BRIDGE_ORG_ID;
    const { fetchOcrStagingSummary } = await import('../../src/app/actions/sandbox.actions');

    const summary = await fetchOcrStagingSummary();

    expect(summary.available).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("reports unavailable WITHOUT querying staging when the caller's org is not the bridge org", async () => {
    const { $queryRaw } = setup();
    mockAuth({ organizationId: 'org-other' });
    process.env.OCR_BRIDGE_ORG_ID = ORG;
    const { fetchOcrStagingSummary } = await import('../../src/app/actions/sandbox.actions');

    const summary = await fetchOcrStagingSummary();

    expect(summary.available).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('reports unavailable when unauthenticated, touching nothing', async () => {
    const { $queryRaw } = setup();
    mockAuth({ unauthenticated: true });
    process.env.OCR_BRIDGE_ORG_ID = ORG;
    const { fetchOcrStagingSummary } = await import('../../src/app/actions/sandbox.actions');

    const summary = await fetchOcrStagingSummary();

    expect(summary.available).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
