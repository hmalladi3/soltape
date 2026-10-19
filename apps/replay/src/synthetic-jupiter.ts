import type { FrameDecoder } from '@soltape/decoder';
import { Status } from '@soltape/decoder';
import type { Clock, PoolVenue } from '@soltape/shared';
import { buildSkeleton, resolveVenue, type PoolFacts } from '@soltape/service/markets/model.js';
import { Reconciler } from '@soltape/service/reconcile/reconciler.js';
import { DEFAULT_THRESHOLDS } from '@soltape/service/reconcile/types.js';
import type { FixtureAccount, FixtureFrame, FixtureHeader, FixtureJupiter } from './fixture.js';

const TOKEN_DECIMALS_OFFSET = 44;

/**
 * Derives a Jupiter track from the recorded pool prices when no API key was available: every
 * `intervalMs`, the on-chain consolidated price per market (computed by the service's own
 * reconciler) with Gaussian jitter of `jitterBps`, converted to USD with a jittered USDC price.
 * Marked `synthetic: true` in the fixture header.
 * @spec RPL-REC-002
 */
export function synthesizeJupiter(
  header: Pick<FixtureHeader, 'markets' | 'durationMs'>,
  accounts: Map<string, FixtureAccount>,
  frames: FixtureFrame[],
  decoder: FrameDecoder,
  opts: { intervalMs?: number; jitterBps?: number; random?: () => number } = {},
): FixtureJupiter[] {
  const interval = opts.intervalMs ?? 2000;
  const jitter = (opts.jitterBps ?? 3) / 1e4;
  const random = opts.random ?? Math.random;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const sk = buildSkeleton(header.markets);
  if (!sk.ok) throw new Error(sk.errors.join('\n'));
  const model = sk.value;
  const facts = new Map<string, PoolFacts>();
  for (const p of model.pools) {
    const acc = accounts.get(p.address);
    if (!acc) continue;
    const d = decoder.decodeAccount(Buffer.from(acc.data, 'base64'), p.venue);
    if (d.status !== Status.ACCOUNT || !d.info) continue;
    const dec = (mint: string, own?: number) => own ?? Buffer.from(accounts.get(mint)?.data ?? '', 'base64')[TOKEN_DECIMALS_OFFSET];
    const decimalsA = dec(d.info.mintA, d.info.decimalsA);
    const decimalsB = dec(d.info.mintB, d.info.decimalsB);
    if (decimalsA === undefined || decimalsB === undefined) continue;
    facts.set(p.address, { address: p.address, venue: p.venue, mintA: d.info.mintA, mintB: d.info.mintB, decimalsA, decimalsB });
  }
  for (const v of ['orca', 'raydium'] as PoolVenue[]) resolveVenue(model, v, facts);
  let now = 0;
  const clock: Clock = { mono: () => now, wall: () => now };
  const rec = new Reconciler({ model, clock, thresholds: { ...DEFAULT_THRESHOLDS, slotSilenceMs: Number.MAX_SAFE_INTEGER, obsMaxAgeMs: Number.MAX_SAFE_INTEGER } });
  rec.onSourceState('orca', 'live');
  rec.onSourceState('raydium', 'live');
  rec.onSourceState('jupiter', 'disabled');
  const apply = (address: string, data: string, slot: number) => {
    const i = model.poolIndexByAddress.get(address);
    const p = i === undefined ? undefined : model.pools[i];
    if (!p?.resolved) return;
    const d = decoder.decodeAccount(Buffer.from(data, 'base64'), p.venue);
    if (d.status === Status.ACCOUNT && d.info) rec.onPoolUpdate(p.index, d.info.sqrtRatio, d.info.liquidity, d.info.tick, slot, now, now, now, 'snapshot');
  };
  for (const p of model.pools) {
    const a = accounts.get(p.address);
    if (a) apply(p.address, a.data, a.slot);
  }
  const out: FixtureJupiter[] = [];
  let fi = 0;
  let slot = Math.max(0, ...[...accounts.values()].map((a) => a.slot));
  for (let t = 0; t <= header.durationMs; t += interval) {
    now = t;
    while (fi < frames.length && frames[fi]!.t <= t * 1000) {
      const f = frames[fi++]!;
      slot = Math.max(slot, f.slot);
      apply(f.address, f.data, f.slot);
    }
    const usdc = 1 + gauss() * 0.5e-4;
    const body: Record<string, { usdPrice: number; blockId: number; decimals?: number }> = {
      [header.markets.quote.mint]: { usdPrice: usdc, blockId: slot, decimals: 6 },
    };
    for (const m of model.markets) {
      const c = rec.consolidated(m.index);
      if (c) body[m.mint] = { usdPrice: c.price * usdc * (1 + gauss() * jitter), blockId: slot };
    }
    out.push({ kind: 'jupiter', t: t * 1000, body: JSON.stringify(body) });
  }
  return out;
}
