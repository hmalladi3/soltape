import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OUT_LEN, Status } from '../src/contract.js';
import { referenceDecoder } from '../src/reference.js';
import { accountFrame, bytes, fixtures, nativeDecoder, newOut, slotFrame } from './helpers.js';

const seeds: Uint8Array[] = [
  ...fixtures.pools.map((p) => bytes(accountFrame(p.data))),
  ...fixtures.pools.map((p) => bytes(accountFrame(p.data, { reverseKeys: true }))),
  bytes(slotFrame(458950024)),
  bytes('{"jsonrpc":"2.0","result":12,"id":1}'),
];

/** Runs both decoders on `frame`; returns [status, slots 0-6] for each. */
function both(frame: Uint8Array): [unknown[], unknown[]] {
  const a = newOut();
  const b = newOut();
  const sa = nativeDecoder.decodeNotification(frame, a);
  const sb = referenceDecoder.decodeNotification(frame, b);
  // Compare bit patterns (NaN-safe, -0-safe) for slots 0-6, and only the slots the status defines.
  const bits = (o: Float64Array, s: number) => {
    const n = s === Status.ACCOUNT ? 7 : s === Status.SLOT ? 2 : 1;
    return Array.from(new BigUint64Array(o.buffer).subarray(0, n), (x) => x.toString(16));
  };
  return [
    [sa, ...bits(a, sa)],
    [sb, ...bits(b, sb)],
  ];
}

const mutate = fc
  .tuple(
    fc.constantFrom(...seeds),
    fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant('flip' as const), at: fc.nat(), byte: fc.integer({ min: 0, max: 255 }) }),
        fc.record({ kind: fc.constant('truncate' as const), at: fc.nat() }),
        fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), byte: fc.integer({ min: 0, max: 255 }) }),
        fc.record({ kind: fc.constant('delete' as const), at: fc.nat() }),
      ),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([seed, ops]) => {
    let b = Array.from(seed);
    for (const op of ops) {
      const at = b.length === 0 ? 0 : op.at % b.length;
      if (op.kind === 'flip') b[at] = op.byte;
      else if (op.kind === 'truncate') b = b.slice(0, at);
      else if (op.kind === 'insert') b.splice(at, 0, op.byte);
      else b.splice(at, 1);
    }
    return Uint8Array.from(b);
  });

describe('native vs reference parity', () => {
  // @spec DEC-PAR-001
  it('agrees on every recorded fixture frame', () => {
    for (const frame of seeds) {
      const [n, r] = both(frame);
      expect(r).toEqual(n);
    }
  });

  // @spec DEC-PAR-001
  it('agrees on mutated frames', () => {
    fc.assert(
      fc.property(mutate, (frame) => {
        const [n, r] = both(frame);
        expect(r).toEqual(n);
      }),
      { numRuns: 3000 },
    );
  });

  // @spec DEC-PAR-001
  it('agrees on arbitrary JSON and arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json().map(bytes), fc.uint8Array({ maxLength: 512 })), (frame) => {
        const [n, r] = both(frame);
        expect(r).toEqual(n);
      }),
      { numRuns: 3000 },
    );
  });

  // @spec DEC-PAR-001
  it('agrees on JSON-shaped notifications with arbitrary field values', () => {
    const field = fc.oneof(fc.integer(), fc.double(), fc.string(), fc.constant(null), fc.boolean(), fc.array(fc.string(), { maxLength: 3 }));
    fc.assert(
      fc.property(fc.record({ sub: field, slot: field, data: field }), (o) => {
        const [n, r] = both(bytes(accountFrame('', o)));
        expect(r).toEqual(n);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('reference decoder', () => {
  // @spec DEC-REF-001
  it('converts u128 with a single correctly rounded BigInt conversion', () => {
    // 2^64 + 2^11 + 1 is not representable; correct rounding gives 2^64 + 2^12, double rounding gives 2^64.
    const b = Buffer.from(fixtures.pools[0]!.data, 'base64');
    const v = (1n << 64n) + (1n << 11n) + 1n;
    b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 49);
    b.writeBigUInt64LE(v >> 64n, 57);
    const out = newOut();
    expect(referenceDecoder.decodeNotification(bytes(accountFrame(b.toString('base64'))), out)).toBe(Status.ACCOUNT);
    expect(out[4]).toBe(Number(v));
    expect(out[4]).toBe(2 ** 64 + 2 ** 12);
  });

  // @spec DEC-REF-002
  it.each(['AAAA AAAA', 'AAA', 'AA==AA==', 'AAB=', '-_-_', 'AAAA\n'])('rejects non-canonical base64 %j like the native decoder', (s) => {
    const frame = bytes(accountFrame('', { data: [s, 'base64'] }));
    expect(nativeDecoder.decodeNotification(frame, newOut())).toBe(Status.BAD_ENCODING);
    expect(referenceDecoder.decodeNotification(frame, newOut())).toBe(Status.BAD_ENCODING);
  });

  // @spec DEC-REF-003
  it('maps an unexpected exception to PANIC', () => {
    const out = new Float64Array(OUT_LEN);
    expect(referenceDecoder.decodeNotification(null as unknown as Uint8Array, out)).toBe(Status.PANIC);
  });
});

describe('native decoder', () => {
  // @spec DEC-NAT-001
  it('borrows the output array: results appear in the caller-owned Float64Array', () => {
    const backing = new ArrayBuffer(OUT_LEN * 8 + 16);
    const out = new Float64Array(backing, 16, OUT_LEN);
    expect(nativeDecoder.decodeNotification(bytes(slotFrame(99)), out)).toBe(Status.SLOT);
    expect(new Float64Array(backing, 16, OUT_LEN)[1]).toBe(99);
  });

  // @spec DEC-NAT-001
  it('accepts a Buffer that views a larger ArrayBuffer without copying requirements', () => {
    const frame = Buffer.from(`xxxx${slotFrame(123)}yyyy`).subarray(4, -4);
    const out = newOut();
    expect(nativeDecoder.decodeNotification(frame, out)).toBe(Status.SLOT);
    expect(out[1]).toBe(123);
  });

  // @spec DEC-NAT-004
  it('is deterministic across repeated calls (no state between calls)', () => {
    const frame = seeds[0]!;
    const first = newOut();
    nativeDecoder.decodeNotification(frame, first);
    for (let i = 0; i < 1000; i++) nativeDecoder.decodeNotification(seeds[i % seeds.length]!, newOut());
    const again = newOut();
    nativeDecoder.decodeNotification(frame, again);
    expect(Array.from(again)).toEqual(Array.from(first));
  });
});
