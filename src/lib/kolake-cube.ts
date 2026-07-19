/**
 * RAJ-649 — Ko Lake BI cube read layer.
 *
 * The cube fact table `scrap.cube_bi` lives on a SEPARATE, read-only Ko Lake
 * Supabase project (ref euqdfxekrxnoibeahogq) — NOT BookLets' own Prisma
 * Postgres. We read it with @supabase/supabase-js using a read-only anon key.
 *
 * The live client is gated behind two env vars; if either is missing the page
 * degrades to an explanatory empty state rather than crashing. The pure
 * helpers below (filters/sort/cap/export) take plain rows so they are unit
 * testable without a live Supabase connection.
 */
import { csvCell } from '@/lib/csv';

export interface CubeRow {
  id?: string | number;
  month: string | null;
  category: string | null;
  party: string | null;
  capex_opex: string | null;
  flow: string | null;
  amount: number | null;
  description?: string | null;
  [key: string]: unknown;
}

/** Dropdown filter fields, populated from distinct values in the data. */
export const CUBE_FILTER_FIELDS = ['month', 'category', 'party', 'capex_opex', 'flow'] as const;
export type CubeFilterField = (typeof CUBE_FILTER_FIELDS)[number];

/** Hard cap on rendered/exported rows (RAJ-649). */
export const CUBE_ROW_CAP = 5000;

export type CubeFilters = Partial<Record<CubeFilterField, string>>;

export interface CubeSort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface CubeQuery {
  filters?: CubeFilters;
  sort?: CubeSort;
}

/** Distinct, sorted values for each filter field (drives the dropdowns). */
export function distinctFilterValues(rows: CubeRow[]): Record<CubeFilterField, string[]> {
  const sets: Record<CubeFilterField, Set<string>> = {
    month: new Set(),
    category: new Set(),
    party: new Set(),
    capex_opex: new Set(),
    flow: new Set(),
  };
  for (const row of rows) {
    for (const field of CUBE_FILTER_FIELDS) {
      const value = row[field];
      if (typeof value === 'string' && value.trim() !== '') {
        sets[field].add(value);
      }
    }
  }
  return {
    month: [...sets.month].sort(),
    category: [...sets.category].sort(),
    party: [...sets.party].sort(),
    capex_opex: [...sets.capex_opex].sort(),
    flow: [...sets.flow].sort(),
  };
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a ?? '').toLowerCase();
  const bs = String(b ?? '').toLowerCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Apply filters (AND), then sort, then cap at CUBE_ROW_CAP. Pure + in-memory. */
export function applyCubeQuery(rows: CubeRow[], query: CubeQuery): CubeRow[] {
  const filters = query.filters ?? {};
  let out = rows.filter((row) =>
    CUBE_FILTER_FIELDS.every((field) => {
      const wanted = filters[field];
      if (!wanted || wanted === '') return true;
      return String(row[field] ?? '') === wanted;
    }),
  );

  if (query.sort) {
    const { field, dir } = query.sort;
    const factor = dir === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => factor * compareValues(a[field], b[field]));
  }

  return out.slice(0, CUBE_ROW_CAP);
}

/** Columns emitted in the CSV/JSON exports, in order. */
export const CUBE_EXPORT_COLUMNS = [
  'id',
  'month',
  'category',
  'party',
  'capex_opex',
  'flow',
  'amount',
  'description',
] as const;

export function cubeRowsToCsv(rows: CubeRow[]): string {
  const header = CUBE_EXPORT_COLUMNS.map((c) => csvCell(c)).join(',');
  const body = rows.map((row) =>
    CUBE_EXPORT_COLUMNS.map((c) => csvCell((row[c] ?? '') as string | number)).join(','),
  );
  return [header, ...body].join('\n');
}

export function cubeRowsToJson(rows: CubeRow[]): string {
  return JSON.stringify(rows, null, 2);
}

// ── Live Supabase read (gated) ──────────────────────────────────────────────

export interface CubeLoadResult {
  ok: boolean;
  rows: CubeRow[];
  error?: string;
}

/**
 * True when both Ko Lake Supabase env vars are present. The page uses this to
 * decide between a live query and an explanatory "not configured" state, so a
 * missing key never crashes the render.
 */
export function isCubeConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_KOLAKE_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_KOLAKE_SUPABASE_ANON_KEY,
  );
}

/**
 * Load up to CUBE_ROW_CAP rows from the read-only Ko Lake cube. Imports
 * @supabase/supabase-js lazily so the module (and its consumers/tests) don't
 * hard-depend on the package or the env being present.
 */
export async function loadCubeRows(): Promise<CubeLoadResult> {
  const url = process.env.NEXT_PUBLIC_KOLAKE_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_KOLAKE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return {
      ok: false,
      rows: [],
      error:
        'Ko Lake cube is not configured. Set NEXT_PUBLIC_KOLAKE_SUPABASE_URL and NEXT_PUBLIC_KOLAKE_SUPABASE_ANON_KEY.',
    };
  }
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(url, anonKey, {
      auth: { persistSession: false },
      db: { schema: 'scrap' },
    });
    const { data, error } = await supabase
      .from('cube_bi')
      .select('*')
      .limit(CUBE_ROW_CAP);
    if (error) {
      return { ok: false, rows: [], error: error.message };
    }
    return { ok: true, rows: (data ?? []) as CubeRow[] };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      error: error instanceof Error ? error.message : 'Failed to load the Ko Lake cube.',
    };
  }
}
