/**
 * RAJ-649 — Ko Lake BI cube read layer (pure helpers).
 *
 * The cube itself (`scrap.cube_bi`) lives on a SEPARATE, read-only Ko Lake
 * Supabase project. These pure helpers build the distinct-value filter maps,
 * apply filters + sort + the 5,000-row cap in memory, and serialise CSV/JSON
 * exports. They take plain rows so they are testable without a live Supabase.
 */
import { describe, it, expect } from 'vitest';
import {
  CUBE_FILTER_FIELDS,
  CUBE_ROW_CAP,
  distinctFilterValues,
  applyCubeQuery,
  cubeRowsToCsv,
  cubeRowsToJson,
  type CubeRow,
} from '../../src/lib/kolake-cube';

const rows: CubeRow[] = [
  { id: '1', month: '2026-06', category: 'Utilities', party: 'CEB', capex_opex: 'OPEX', flow: 'OUT', amount: 120.5, description: 'Electricity' },
  { id: '2', month: '2026-07', category: 'Utilities', party: 'Water Board', capex_opex: 'OPEX', flow: 'OUT', amount: 40, description: 'Water' },
  { id: '3', month: '2026-07', category: 'Furniture', party: 'Damro', capex_opex: 'CAPEX', flow: 'OUT', amount: 900, description: 'Beds' },
  { id: '4', month: '2026-07', category: 'Rental', party: 'Guest A', capex_opex: 'OPEX', flow: 'IN', amount: 1500, description: 'Booking' },
];

describe('distinctFilterValues', () => {
  it('returns sorted distinct values per filter field', () => {
    const map = distinctFilterValues(rows);
    expect(map.month).toEqual(['2026-06', '2026-07']);
    expect(map.category).toEqual(['Furniture', 'Rental', 'Utilities']);
    expect(map.capex_opex).toEqual(['CAPEX', 'OPEX']);
    expect(map.flow).toEqual(['IN', 'OUT']);
    expect(map.party).toEqual(['CEB', 'Damro', 'Guest A', 'Water Board']);
  });

  it('exposes exactly the documented filter fields', () => {
    expect(CUBE_FILTER_FIELDS).toEqual(['month', 'category', 'party', 'capex_opex', 'flow']);
  });

  it('ignores null/empty values', () => {
    const map = distinctFilterValues([
      ...rows,
      { id: '5', month: null, category: '', party: 'X', capex_opex: 'OPEX', flow: 'OUT', amount: 1 } as unknown as CubeRow,
    ]);
    expect(map.month).toEqual(['2026-06', '2026-07']);
  });
});

describe('applyCubeQuery', () => {
  it('filters by a single field', () => {
    const out = applyCubeQuery(rows, { filters: { month: '2026-07' } });
    expect(out.map((r) => r.id)).toEqual(['2', '3', '4']);
  });

  it('ANDs multiple filters', () => {
    const out = applyCubeQuery(rows, { filters: { month: '2026-07', flow: 'OUT' } });
    expect(out.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('ignores empty filter values (treated as "no filter")', () => {
    const out = applyCubeQuery(rows, { filters: { month: '', category: '' } });
    expect(out).toHaveLength(4);
  });

  it('sorts ascending and descending by a column', () => {
    const asc = applyCubeQuery(rows, { sort: { field: 'amount', dir: 'asc' } });
    expect(asc.map((r) => r.amount)).toEqual([40, 120.5, 900, 1500]);
    const desc = applyCubeQuery(rows, { sort: { field: 'amount', dir: 'desc' } });
    expect(desc.map((r) => r.amount)).toEqual([1500, 900, 120.5, 40]);
  });

  it('sorts strings case-insensitively', () => {
    const out = applyCubeQuery(rows, { sort: { field: 'category', dir: 'asc' } });
    expect(out.map((r) => r.category)).toEqual(['Furniture', 'Rental', 'Utilities', 'Utilities']);
  });

  it('caps output at CUBE_ROW_CAP rows', () => {
    const many: CubeRow[] = Array.from({ length: CUBE_ROW_CAP + 500 }, (_, i) => ({
      id: String(i), month: '2026-07', category: 'C', party: 'P', capex_opex: 'OPEX', flow: 'OUT', amount: i,
    }));
    expect(applyCubeQuery(many, {})).toHaveLength(CUBE_ROW_CAP);
    expect(CUBE_ROW_CAP).toBe(5000);
  });
});

describe('cubeRowsToCsv', () => {
  it('emits a header row and escapes formula-injection', () => {
    const csv = cubeRowsToCsv([
      { id: '1', month: '2026-07', category: '=cmd', party: 'P', capex_opex: 'OPEX', flow: 'OUT', amount: 10, description: 'ok' },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('month');
    expect(lines[1]).toContain('\'=cmd'); // neutralised
  });

  it('handles empty input with just a header', () => {
    const csv = cubeRowsToCsv([]);
    expect(csv.trim().split('\n')).toHaveLength(1);
  });
});

describe('cubeRowsToJson', () => {
  it('produces parseable JSON of the rows', () => {
    const json = cubeRowsToJson(rows.slice(0, 1));
    expect(JSON.parse(json)).toEqual(rows.slice(0, 1));
  });
});
