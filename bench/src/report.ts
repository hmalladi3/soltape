import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import { knee, type CellResult } from './analysis.js';

export interface MachineSpec {
  host: string;
  platform: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  node: string;
  rust: string;
  commit: string;
  label: string;
}

/** @spec RPL-BEN-008, RPL-BEN-010 */
export function machineSpec(): MachineSpec {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return 'unknown';
    }
  };
  const ci = process.env['GITHUB_ACTIONS'] === 'true';
  return {
    host: os.hostname().split('.')[0] ?? 'host',
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    rust: run('rustc --version'),
    commit: process.env['SOLTAPE_COMMIT'] && process.env['SOLTAPE_COMMIT'] !== 'unknown' ? process.env['SOLTAPE_COMMIT'] : run('git rev-parse --short HEAD'),
    label: ci
      ? 'GitHub-hosted runner (shared, noisy): regression signal only'
      : os.platform() === 'linux'
        ? 'local Linux host'
        : `non-Linux host (${os.platform()}): indicative only; headline numbers come from Linux`,
  };
}

const us = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${Math.round(v)} µs`);

/** Markdown report: machine spec, one row per cell, and the knee per subscriber count. */
export function renderMarkdown(cells: CellResult[], m: MachineSpec, meta: { durationS: number; warmupS: number; benchMarkets: number }): string {
  const rows = cells
    .map(
      (c) =>
        `| ${c.rate.toLocaleString('en-US')} | ${c.subscribers} | ${us(c.e2e.p50)} | ${us(c.e2e.p99)} | ${us(c.e2e.p999)} | ${us(c.e2e.max)} | ${us(c.internal.p50)} | ${us(c.internal.p99)} | ${us(c.internal.p999)} | ${c.eventLoopP99Ms.toFixed(2)} ms | ${(c.e2e.conflationRatio * 100).toFixed(2)}% | ${Math.round(c.rssMb)} MB | ${Math.round(c.gcPauseMs)} ms | ${c.persistDrops} |`,
    )
    .join('\n');
  const k = [...knee(cells)]
    .map(([s, v]) => `- ${s} subscriber${s === 1 ? '' : 's'}: ${v ? `knee at ${v.rate.toLocaleString('en-US')} updates/s (${v.reason})` : 'no knee within the tested rates'}`)
    .join('\n');
  return `## soltape benchmark

**${m.label}**

${m.cpu}, ${m.cores} cores, ${m.memoryGb} GB, ${m.platform}. Node ${m.node}, ${m.rust}, commit \`${m.commit}\`.
${meta.benchMarkets} synthetic markets (2 pools each), ${meta.warmupS} s warmup then ${meta.durationS} s measured per cell. Persistence: ${cells[0]?.persistence ?? 'unknown'}.
End-to-end = client receive − intended send (open-loop schedule). Internal = frame receipt → last WebSocket write, from the service's HDR window.

| Rate (updates/s) | Subscribers | e2e p50 | e2e p99 | e2e p99.9 | e2e max | internal p50 | internal p99 | internal p99.9 | event-loop p99 | conflated | RSS | GC pause | persist drops |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

${k}
`;
}

/** @spec RPL-BEN-009 */
export function appendSummary(markdown: string): boolean {
  const path = process.env['GITHUB_STEP_SUMMARY'];
  if (!path) return false;
  appendFileSync(path, markdown + '\n');
  return true;
}
