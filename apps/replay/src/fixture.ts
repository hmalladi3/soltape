import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import type { MarketsFile, PoolVenue } from '@soltape/shared';

export const FIXTURE_VERSION = 1;

export interface FixtureHeader {
  kind: 'header';
  version: number;
  recordedAt: string;
  durationMs: number;
  recorderVersion: string;
  commit: string;
  programIds: Record<PoolVenue, string>;
  markets: MarketsFile;
  /** True when the Jupiter track was synthesised from pool prices (no API key at record time). */
  synthetic: { jupiter: boolean };
}

/** Boot state of one account (pools and mints), as getMultipleAccounts returned it. */
export interface FixtureAccount {
  kind: 'account';
  address: string;
  owner: string;
  data: string;
  slot: number;
}

/** One account notification exactly as received, plus the parsed fields replay rebuilds from. */
export interface FixtureFrame {
  kind: 'frame';
  /** Microseconds since recording start. */
  t: number;
  venue: PoolVenue;
  address: string;
  slot: number;
  data: string;
  lamports: number;
  owner: string;
  space: number;
  /** The raw frame text as received from mainnet (decoder fixtures, verification). */
  body: string;
}

export interface FixtureSlot {
  kind: 'slot';
  t: number;
  venue: PoolVenue;
  slot: number;
}

export interface FixtureJupiter {
  kind: 'jupiter';
  t: number;
  /** Jupiter Price API v3 response body (JSON text). */
  body: string;
}

export type FixtureLine = FixtureHeader | FixtureAccount | FixtureFrame | FixtureSlot | FixtureJupiter;

export interface Fixture {
  header: FixtureHeader;
  accounts: Map<string, FixtureAccount>;
  frames: FixtureFrame[];
  slots: FixtureSlot[];
  jupiter: FixtureJupiter[];
}

/**
 * Writes fixture lines as gzipped NDJSON, header first.
 * @spec RPL-REC-003
 */
export async function writeFixture(path: string, lines: Iterable<FixtureLine>): Promise<void> {
  const gz = createGzip({ level: 9 });
  const out = createWriteStream(path);
  gz.pipe(out);
  for (const l of lines) if (!gz.write(JSON.stringify(l) + '\n')) await new Promise((r) => gz.once('drain', r));
  gz.end();
  await new Promise<void>((resolve, reject) => {
    out.once('finish', resolve);
    out.once('error', reject);
  });
}

export function parseFixture(text: string): Fixture {
  let header: FixtureHeader | undefined;
  const accounts = new Map<string, FixtureAccount>();
  const frames: FixtureFrame[] = [];
  const slots: FixtureSlot[] = [];
  const jupiter: FixtureJupiter[] = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const l = JSON.parse(raw) as FixtureLine;
    if (l.kind === 'header') header = l;
    else if (l.kind === 'account') accounts.set(l.address, l);
    else if (l.kind === 'frame') frames.push(l);
    else if (l.kind === 'slot') slots.push(l);
    else if (l.kind === 'jupiter') jupiter.push(l);
  }
  if (!header) throw new Error('fixture has no header line');
  if (header.version !== FIXTURE_VERSION) throw new Error(`fixture version ${header.version}, expected ${FIXTURE_VERSION}`);
  const byT = (a: { t: number }, b: { t: number }) => a.t - b.t;
  return { header, accounts, frames: frames.sort(byT), slots: slots.sort(byT), jupiter: jupiter.sort(byT) };
}

export function readFixture(path: string): Fixture {
  return parseFixture(gunzipSync(readFileSync(path)).toString('utf8'));
}

/** Streams lines without loading the whole file (large local recordings). */
export async function* streamFixture(path: string): AsyncGenerator<FixtureLine> {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line) as FixtureLine;
}
