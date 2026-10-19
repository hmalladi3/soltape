import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CellResult } from './analysis.js';

/** Committed CI budget: e2e p99 (µs) per "rate x subscribers" cell. Null = not gated. */
export type Baseline = Record<string, number | string | null>;

export const REGRESSION_FACTOR = 5;

/**
 * Fails when a gated cell's end-to-end p99 exceeds 5x its committed baseline. The factor is
 * deliberately loose: GitHub-hosted runners are shared and noisy, but a 5x regression is real.
 * @spec DLV-CI-008
 */
export function regressions(cells: CellResult[], baseline: Baseline, factor = REGRESSION_FACTOR): string[] {
  const out: string[] = [];
  for (const c of cells) {
    const key = `${c.rate}x${c.subscribers}`;
    const b = baseline[key];
    if (typeof b !== 'number') continue;
    if (c.e2e.p99 > b * factor) out.push(`${key}: e2e p99 ${c.e2e.p99} µs > ${factor} x baseline ${b} µs`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [resultPath, baselinePath] = process.argv.slice(2);
  const cells = (JSON.parse(readFileSync(resultPath!, 'utf8')) as { cells: CellResult[] }).cells;
  const r = regressions(cells, JSON.parse(readFileSync(baselinePath!, 'utf8')) as Baseline);
  if (r.length) {
    console.error(`benchmark regression:\n  ${r.join('\n  ')}`);
    process.exit(1);
  }
  console.log('no benchmark regression beyond 5x baseline');
}
