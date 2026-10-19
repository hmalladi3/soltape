import { createRequire } from 'node:module';
import type { DecodeAccountResult, FrameDecoder, Venue } from './contract.js';

interface NativeBinding {
  decodeNotification(frame: Uint8Array, out: Float64Array): number;
  decodeAccount(data: Uint8Array, venue: string): DecodeAccountResult;
}

/** Loads the platform's prebuilt native addon. Throws if it is missing or fails to load. */
export function loadNativeDecoder(): FrameDecoder {
  const require = createRequire(import.meta.url);
  const binding = require(`../native/soltape-decoder.${process.platform}-${process.arch}${libcSuffix()}.node`) as NativeBinding;
  return {
    impl: 'native',
    decodeNotification: (frame, out) => binding.decodeNotification(frame, out),
    decodeAccount: (data: Uint8Array, venue: Venue) => binding.decodeAccount(data, venue),
  };
}

function libcSuffix(): string {
  return process.platform === 'linux' ? '-gnu' : '';
}
