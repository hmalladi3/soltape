import { describe, expect, it } from 'vitest';
import type { FrameDecoder } from '../src/contract.js';
import { referenceDecoder } from '../src/reference.js';
import { selectDecoder } from '../src/select.js';

const fakeNative: FrameDecoder = { ...referenceDecoder, impl: 'native' };
const failing = (): FrameDecoder => {
  throw new Error('Cannot find module soltape-decoder.linux-x64-gnu.node');
};

describe('selectDecoder', () => {
  // @spec RUN-DEC-001
  it('auto: falls back to the reference decoder with the load error as reason', () => {
    const sel = selectDecoder('auto', failing);
    expect(sel.decoder.impl).toBe('reference');
    expect(sel.fallbackReason).toContain('Cannot find module');
  });

  // @spec RUN-DEC-001
  it('auto: uses the native decoder when it loads', () => {
    const sel = selectDecoder('auto', () => fakeNative);
    expect(sel.decoder.impl).toBe('native');
    expect(sel.fallbackReason).toBeUndefined();
  });

  // @spec RUN-DEC-002
  it('native: throws when the addon fails to load', () => {
    expect(() => selectDecoder('native', failing)).toThrow(/Cannot find module/);
  });

  // @spec RUN-DEC-003
  it('ts: uses the reference decoder without attempting a native load', () => {
    let attempted = false;
    const sel = selectDecoder('ts', () => {
      attempted = true;
      return fakeNative;
    });
    expect(sel.decoder.impl).toBe('reference');
    expect(attempted).toBe(false);
  });
});
