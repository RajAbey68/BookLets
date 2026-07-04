import { describe, it, expect } from 'vitest';
import { parseThresholds, compareThresholds } from '../../scripts/coverage-ratchet.mjs';

const configWith = (thresholds: string) => `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: ${thresholds},
    },
  },
});
`;

describe('parseThresholds', () => {
  it('extracts all four metrics from a vitest config source', () => {
    const src = configWith('{ lines: 22, statements: 22, branches: 83, functions: 63 }');
    expect(parseThresholds(src)).toEqual({
      lines: 22,
      statements: 22,
      branches: 83,
      functions: 63,
    });
  });

  it('extracts decimal thresholds', () => {
    const src = configWith('{ lines: 22.5, branches: 83.69 }');
    expect(parseThresholds(src)).toEqual({ lines: 22.5, branches: 83.69 });
  });

  it('throws when no thresholds block exists (fail closed)', () => {
    const src = configWith('undefined').replace(/thresholds:.*\n/, '');
    expect(() => parseThresholds(src)).toThrow(/thresholds/i);
  });
});

describe('compareThresholds', () => {
  const base = { lines: 22, statements: 22, branches: 83, functions: 63 };

  it('passes when head equals base', () => {
    expect(compareThresholds(base, { ...base })).toEqual([]);
  });

  it('passes when head raises a threshold', () => {
    expect(compareThresholds(base, { ...base, lines: 30 })).toEqual([]);
  });

  it('fails when any threshold is lowered', () => {
    const violations = compareThresholds(base, { ...base, branches: 70 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/branches.*83.*70/);
  });

  it('fails when a metric present in base is removed in head', () => {
    const head: Record<string, number> = { ...base };
    delete head.functions;
    const violations = compareThresholds(base, head);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/functions.*removed/i);
  });

  it('reports every lowered metric, not just the first', () => {
    const violations = compareThresholds(base, {
      lines: 6,
      statements: 6,
      branches: 69,
      functions: 39,
    });
    expect(violations).toHaveLength(4);
  });
});

describe('parseThresholds — bypass hardening (Ultra Judge findings)', () => {
  it('ignores commented-out decoy thresholds blocks (line comments)', () => {
    const src =
      '// thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 }\n' +
      configWith('{ lines: 10, statements: 10, branches: 10, functions: 10 }');
    expect(parseThresholds(src)).toEqual({ lines: 10, statements: 10, branches: 10, functions: 10 });
  });

  it('ignores commented-out decoy thresholds blocks (block comments)', () => {
    const src =
      '/* thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 } */\n' +
      configWith('{ lines: 10, statements: 10, branches: 10, functions: 10 }');
    expect(parseThresholds(src)).toEqual({ lines: 10, statements: 10, branches: 10, functions: 10 });
  });

  it('rejects thresholds above 100 (invalid percentage)', () => {
    expect(() => parseThresholds(configWith('{ lines: 150, branches: 83 }'))).toThrow(/150/);
  });
});
