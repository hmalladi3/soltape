import type { FrameDecoder } from './contract.js';
import { loadNativeDecoder } from './native.js';
import { referenceDecoder } from './reference.js';

export type DecoderMode = 'auto' | 'native' | 'ts';
export interface DecoderSelection {
  decoder: FrameDecoder;
  /** Set when mode was `auto` and the native addon failed to load. */
  fallbackReason?: string;
}

/**
 * Chooses the decoder per `DECODER`. Throws when mode is `native` and the addon cannot be
 * loaded; the runtime maps that to exit code 2.
 * @spec RUN-DEC-001, RUN-DEC-002, RUN-DEC-003
 */
export function selectDecoder(mode: DecoderMode, loadNative: () => FrameDecoder = loadNativeDecoder): DecoderSelection {
  if (mode === 'ts') return { decoder: referenceDecoder };
  if (mode === 'native') return { decoder: loadNative() };
  try {
    return { decoder: loadNative() };
  } catch (err) {
    return { decoder: referenceDecoder, fallbackReason: err instanceof Error ? err.message : String(err) };
  }
}
