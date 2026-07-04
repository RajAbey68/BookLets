#!/usr/bin/env node
// Coverage-threshold ratchet (RAJ-539).
// Compares the coverage thresholds in a head (PR) vitest config against the
// base (main) config and fails if any threshold was lowered or removed.
// Thresholds may only stay equal or go up.
//
// Usage: node scripts/coverage-ratchet.mjs <base-vitest-config> <head-vitest-config>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METRICS = ['lines', 'statements', 'branches', 'functions'];

export function parseThresholds(source) {
  const block = source.match(/thresholds\s*:\s*\{([^}]*)\}/);
  if (!block) {
    throw new Error('No coverage thresholds block found in vitest config — refusing to pass (fail closed).');
  }
  const thresholds = {};
  for (const metric of METRICS) {
    const m = block[1].match(new RegExp(`${metric}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`));
    if (m) thresholds[metric] = parseFloat(m[1]);
  }
  if (Object.keys(thresholds).length === 0) {
    throw new Error('Thresholds block contains no recognised metrics — refusing to pass (fail closed).');
  }
  return thresholds;
}

export function compareThresholds(base, head) {
  const violations = [];
  for (const metric of METRICS) {
    if (!(metric in base)) continue;
    if (!(metric in head)) {
      violations.push(`${metric}: threshold removed (was ${base[metric]}) — ratchet only allows equal or higher`);
    } else if (head[metric] < base[metric]) {
      violations.push(`${metric}: lowered from ${base[metric]} to ${head[metric]} — ratchet only allows equal or higher`);
    }
  }
  return violations;
}

function main() {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error('Usage: node scripts/coverage-ratchet.mjs <base-vitest-config> <head-vitest-config>');
    process.exit(2);
  }
  const base = parseThresholds(readFileSync(basePath, 'utf8'));
  const head = parseThresholds(readFileSync(headPath, 'utf8'));
  const violations = compareThresholds(base, head);
  if (violations.length > 0) {
    console.error('Coverage ratchet violation (RAJ-539):');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`Coverage ratchet OK: ${JSON.stringify(head)} >= ${JSON.stringify(base)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
