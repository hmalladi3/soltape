import type { FrameDecoder } from './contract.js';

export type DecoderMode = 'auto' | 'native' | 'ts';
export interface DecoderSelection {
  decoder: FrameDecoder;
  /** Set when mode was `auto` and the native addon failed to load. */
  fallbackReason?: string;
}

/**
 * Chooses the decoder per `DECODER` (RUN-DEC-001..003). Throws when mode is `native`
 * and the addon cannot be loaded; the runtime maps that to exit code 2.
 */
export function selectDecoder(_mode: DecoderMode, _loadNative?: () => FrameDecoder): DecoderSelection {
  throw new Error('not implemented'); // Phase 5 stub
}
