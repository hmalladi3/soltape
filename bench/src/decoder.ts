import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativeDecoder, OUT_LEN, referenceDecoder, type FrameDecoder } from '@soltape/decoder';
import hdr from 'hdr-histogram-js';
import { appendSummary, machineSpec } from './report.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

export interface DecoderBenchResult {
  impl: string;
  framesPerSec: number;
  /** Per-call latency under GC pressure, nanoseconds. */
  p50: number;
  p99: number;
  p999: number;
  max: number;
}

/** Real account-notification frames from the committed decoder fixtures. */
export function benchFrames(): Buffer[] {
  const fx = JSON.parse(readFileSync(join(root, 'packages/decoder/fixtures/accounts.json'), 'utf8')) as { pools: { data: string; owner: string; slot: number }[] };
  return fx.pools.map((p, i) =>
    Buffer.from(
      `{"jsonrpc":"2.0","method":"accountNotification","params":{"result":{"context":{"slot":${p.slot}},"value":{"data":["${p.data}","base64"],"executable":false,"lamports":1,"owner":"${p.owner}","rentEpoch":18446744073709551615,"space":${Buffer.from(p.data, 'base64').length}}},"subscription":${i + 1}}}`,
    ),
  );
}

/**
 * Phase 1: frames/s over `throughputMs`. Phase 2: per-call latency in an HDR histogram while
 * the heap is churned between calls (garbage that forces regular collections).
 * @spec RPL-DBN-001, RPL-DBN-002
 */
export function benchDecoder(d: FrameDecoder, frames: Buffer[], throughputMs = 5000, latencyCalls = 500_000): DecoderBenchResult {
  const out = new Float64Array(OUT_LEN);
  for (let i = 0; i < 50_000; i++) d.decodeNotification(frames[i % frames.length]!, out);
  let n = 0;
  const end = performance.now() + throughputMs;
  while (performance.now() < end) for (let k = 0; k < 1000; k++) d.decodeNotification(frames[n++ % frames.length]!, out);
  const framesPerSec = (n / throughputMs) * 1000;
  const h = hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 1e9, numberOfSignificantValueDigits: 3, useWebAssembly: false });
  let keep: unknown[] = [];
  for (let i = 0; i < latencyCalls; i++) {
    if (i % 64 === 0) {
      keep.push(new Array(256).fill({ i }));
      if (keep.length > 512) keep = [];
    }
    const t = process.hrtime.bigint();
    d.decodeNotification(frames[i % frames.length]!, out);
    h.recordValue(Math.max(1, Number(process.hrtime.bigint() - t)));
  }
  const r = { impl: d.impl, framesPerSec, p50: h.getValueAtPercentile(50), p99: h.getValueAtPercentile(99), p999: h.getValueAtPercentile(99.9), max: h.maxValue };
  h.destroy();
  return r;
}

export function renderDecoderMarkdown(rs: DecoderBenchResult[]): string {
  const m = machineSpec();
  const rows = rs.map((r) => `| ${r.impl} | ${Math.round(r.framesPerSec).toLocaleString('en-US')} | ${(r.p50 / 1000).toFixed(2)} µs | ${(r.p99 / 1000).toFixed(2)} µs | ${(r.p999 / 1000).toFixed(2)} µs | ${(r.max / 1000).toFixed(1)} µs |`).join('\n');
  return `## Decoder microbenchmark\n\n**${m.label}**: ${m.cpu}, Node ${m.node}, ${m.rust}, commit \`${m.commit}\`. Real mainnet account frames; latency measured under GC pressure.\n\n| Decoder | Frames/s | p50 | p99 | p99.9 | max |\n|---|---:|---:|---:|---:|---:|\n${rows}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const frames = benchFrames();
  const results = [benchDecoder(loadNativeDecoder(), frames), benchDecoder(referenceDecoder, frames)];
  const md = renderDecoderMarkdown(results);
  console.log(md);
  if (process.argv.includes('--summary')) appendSummary(md);
}
