import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNativeDecoder, referenceDecoder } from '@soltape/decoder';
import { describe, expect, it } from 'vitest';
import { joinLatencies, knee, promValue, type CellResult, type SendLog } from '../src/analysis.js';
import { benchDecoder, benchFrames, renderDecoderMarkdown } from '../src/decoder.js';
import { appendSummary, machineSpec, renderMarkdown } from '../src/report.js';

const log = (n: number, periodNs: number, warmupMs = 0, t0 = 1_000_000_000n): SendLog => ({
  t0Ns: t0,
  warmupMs,
  slots: Float64Array.from({ length: n }, (_, i) => 100 + i),
  intendedNs: Float64Array.from({ length: n }, (_, i) => i * periodNs),
});

const cell = (rate: number, subscribers: number, p99: number, conflation = 0, loop = 0.1): CellResult => ({
  rate,
  subscribers,
  e2e: { p50: p99 / 2, p99, p999: p99, max: p99, samples: 10, conflationRatio: conflation, measuredInputs: 10 },
  internal: { p50: 10, p99: 20, p999: 30 },
  eventLoopP99Ms: loop,
  rssMb: 100,
  gcPauseMs: 1,
  persistDrops: 0,
  persistence: 'redis up, postgres up',
});

describe('benchmark analysis', () => {
  // @spec RPL-BEN-003
  it('measures end-to-end latency from the intended send time, joined by trigger slot', () => {
    // Client base is 500 µs after replay t0; every frame arrives 120 µs after it was due.
    const l = log(1000, 1_000_000);
    const recvNs = Float64Array.from({ length: 1000 }, (_, i) => i * 1_000_000 + 120_000 - 500_000);
    const r = joinLatencies(l, [{ baseNs: (l.t0Ns + 500_000n).toString(), slots: l.slots, recvNs }]);
    expect(r.samples).toBe(1000);
    expect(r.p50).toBe(120);
    expect(r.p99).toBe(120);
  });

  // @spec RPL-BEN-003
  it('charges a stalled service with the whole delay (no coordinated omission)', () => {
    // Frames 500..599 are delivered late, all at the time frame 600 was due.
    const l = log(1000, 1_000_000);
    const recvNs = Float64Array.from({ length: 1000 }, (_, i) => (i >= 500 && i < 600 ? 600 * 1_000_000 : i * 1_000_000) + 50_000);
    const r = joinLatencies(l, [{ baseNs: l.t0Ns.toString(), slots: l.slots, recvNs }]);
    expect(r.max).toBeGreaterThanOrEqual(99_000);
    expect(r.p99).toBeGreaterThan(50_000);
  });

  // @spec RPL-BEN-004
  it('counts inputs that never reached a socket as conflated, separately from latency, and drops warmup', () => {
    const l = log(1000, 1_000_000, 100);
    const keep = Array.from({ length: 1000 }, (_, i) => i).filter((i) => i % 10 !== 0);
    const r = joinLatencies(l, [{ baseNs: l.t0Ns.toString(), slots: Float64Array.from(keep, (i) => 100 + i), recvNs: Float64Array.from(keep, (i) => i * 1_000_000 + 10_000) }]);
    expect(r.measuredInputs).toBe(900);
    expect(r.conflationRatio).toBeCloseTo(0.1, 2);
    expect(r.samples).toBe(810);
  });

  // @spec RPL-BEN-007
  it('reports the knee as the lowest rate breaching p99, conflation or event-loop limits, per subscriber count', () => {
    const k = knee([cell(1000, 1, 300), cell(10000, 1, 800), cell(20000, 1, 1500), cell(1000, 100, 400), cell(10000, 100, 600, 0.05), cell(1000, 1000, 200, 0, 2)]);
    expect(k.get(1)).toEqual({ rate: 20000, reason: 'e2e p99 1.50 ms' });
    expect(k.get(100)).toEqual({ rate: 10000, reason: 'conflation 5.0%' });
    expect(k.get(1000)).toEqual({ rate: 1000, reason: 'event-loop p99 2.00 ms' });
    expect(knee([cell(1000, 1, 100)]).get(1)).toBeNull();
  });

  it('reads summed values from Prometheus text', () => {
    const t = 'a_total{sink="x"} 2\na_total{sink="y"} 3\nb 7\n';
    expect(promValue(t, 'a_total')).toBe(5);
    expect(promValue(t, 'a_total', { sink: 'y' })).toBe(3);
    expect(promValue(t, 'b')).toBe(7);
    expect(promValue(t, 'missing')).toBeNaN();
  });
});

describe('benchmark reports', () => {
  // @spec RPL-BEN-005, RPL-BEN-006, RPL-BEN-008
  it('renders every reported field with the machine specification', () => {
    const md = renderMarkdown([cell(1000, 1, 300), cell(10000, 1, 1500)], machineSpec(), { durationS: 30, warmupS: 10, benchMarkets: 10 });
    for (const h of ['e2e p50', 'e2e p99', 'e2e p99.9', 'e2e max', 'internal p50', 'internal p99', 'internal p99.9', 'event-loop p99', 'conflated', 'RSS', 'GC pause', 'persist drops']) expect(md).toContain(h);
    expect(md).toContain('10 s warmup then 30 s measured');
    expect(md).toMatch(/Node v\d+/);
    expect(md).toContain('knee at 10,000 updates/s');
  });

  // @spec RPL-BEN-009
  it('appends the report to $GITHUB_STEP_SUMMARY when set', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'soltape-')), 'summary.md');
    const prev = process.env['GITHUB_STEP_SUMMARY'];
    process.env['GITHUB_STEP_SUMMARY'] = path;
    try {
      expect(appendSummary('## hello')).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('## hello');
    } finally {
      if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY'];
      else process.env['GITHUB_STEP_SUMMARY'] = prev;
    }
  });

  // @spec RPL-BEN-010
  it('labels results from non-Linux hosts and CI runners', () => {
    const m = machineSpec();
    if (process.env['GITHUB_ACTIONS'] === 'true') expect(m.label).toMatch(/noisy/);
    else if (process.platform !== 'linux') expect(m.label).toMatch(/non-Linux/);
    else expect(m.label).toMatch(/Linux/);
  });
});

describe('decoder microbenchmark', () => {
  // @spec RPL-DBN-001, RPL-DBN-002
  it('measures throughput and per-call latency under GC pressure for both decoders', () => {
    const frames = benchFrames();
    expect(frames.length).toBeGreaterThan(0);
    const rs = [benchDecoder(loadNativeDecoder(), frames, 100, 20_000), benchDecoder(referenceDecoder, frames, 100, 20_000)];
    for (const r of rs) {
      expect(r.framesPerSec).toBeGreaterThan(1000);
      expect(r.p99).toBeGreaterThanOrEqual(r.p50);
    }
    expect(renderDecoderMarkdown(rs)).toContain('| native |');
  });
});

describe('benchmark orchestration', () => {
  const built = existsSync(new URL('../../apps/service/dist/main.js', import.meta.url)) && existsSync(new URL('../dist/client.js', import.meta.url));
  // @spec RPL-BEN-001, RPL-BEN-002
  it.skipIf(!built || !readdirSync(new URL('../../fixtures', import.meta.url)).some((f) => f.startsWith('session-')))('runs a tiny matrix end to end across separate processes', async () => {
    const { runBench } = await import('../src/run.js');
    const out = mkdtempSync(join(tmpdir(), 'soltape-bench-out-'));
    const r = await runBench({ rates: [500], subscribers: [2], warmupS: 1, durationS: 2, clients: 2, benchMarkets: 2, summary: false, outDir: out, replayPort: 28899, servicePort: 28080 });
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]!.e2e.samples).toBeGreaterThan(100);
    expect(r.cells[0]!.e2e.p50).toBeGreaterThan(0);
    expect(existsSync(r.jsonPath) && existsSync(r.mdPath)).toBe(true);
  }, 120_000);
});
