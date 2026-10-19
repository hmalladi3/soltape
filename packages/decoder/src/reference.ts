import { Out, Status, type DecodeAccountResult, type FrameDecoder, type Venue } from './contract.js';

// TypeScript reference decoder: same contract as the native addon, bit-identical output.
export const referenceDecoder: FrameDecoder = {
  impl: 'reference',
  decodeNotification(_frame: Uint8Array, out: Float64Array): number {
    out[Out.SUB] = -1;
    return Status.OTHER; // Phase 5 stub
  },
  decodeAccount(_data: Uint8Array, _venue: Venue): DecodeAccountResult {
    return { status: Status.UNKNOWN_LAYOUT }; // Phase 5 stub
  },
};
