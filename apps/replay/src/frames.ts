/** Builds frames in exactly the shape (and key order) Solana RPC sends. */

export interface AccountValue {
  data: string;
  lamports: number;
  owner: string;
  space: number;
}

const RENT_EPOCH = '18446744073709551615';

/** Prefix/suffix around the slot, so rate mode can splice in a new slot cheaply. */
export function accountFrameParts(v: AccountValue, sub: number): { prefix: string; suffix: string } {
  return {
    prefix: '{"jsonrpc":"2.0","method":"accountNotification","params":{"result":{"context":{"slot":',
    suffix: `},"value":{"data":["${v.data}","base64"],"executable":false,"lamports":${v.lamports},"owner":"${v.owner}","rentEpoch":${RENT_EPOCH},"space":${v.space}}},"subscription":${sub}}}`,
  };
}

export function accountFrame(v: AccountValue, sub: number, slot: number): string {
  const p = accountFrameParts(v, sub);
  return `${p.prefix}${slot}${p.suffix}`;
}

export function slotFrame(sub: number, slot: number): string {
  return `{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":${slot - 1},"root":${slot - 32},"slot":${slot}},"subscription":${sub}}}`;
}

export function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', result, id });
}

export function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id });
}

/** Malformed variants of a valid frame, for fault injection (`garbage`). */
export function garbageVariants(valid: string): string[] {
  const b64Start = valid.indexOf('"data":["') + 9;
  return [
    valid.slice(0, Math.floor(valid.length / 2)), // truncated JSON
    valid.slice(0, b64Start) + '***' + valid.slice(b64Start + 3), // invalid base64
    valid.slice(0, b64Start) + 'AAAA' + valid.slice(b64Start + 4), // wrong discriminator
    valid.replace(/"subscription":(\d+)/, '"subscription":"$1"'), // wrong type
    '{"jsonrpc":"2.0","method":"accountNotification"', // fragment
    '\u0000\u0001\u0002 not json',
  ];
}
