import { Status, type FrameDecoder } from '@soltape/decoder';
import type { PoolVenue } from '@soltape/shared';
import type { PoolFacts } from '../markets/model.js';
import type { RpcFailure, RpcHttp } from './rpc-http.js';

export const PROGRAM_IDS: Record<PoolVenue, string> = {
  orca: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  raydium: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
};
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
/** SPL Mint layout: decimals at byte 44 (same base layout for Token-2022). */
const MINT_DECIMALS_OFFSET = 44;
const MINT_MIN_LEN = 82;

export interface PoolProblem {
  address: string;
  message: string;
}

export type VenueValidation = { kind: 'unreachable'; failure: RpcFailure } | { kind: 'checked'; facts: Map<string, PoolFacts>; problems: PoolProblem[] };

/**
 * Fetches and checks a venue's pools: each account must exist, be owned by the venue's
 * program and decode as its layout. Whirlpool mint decimals come from the SPL Mint accounts;
 * Raydium CLMM stores them in the pool. Network failures are reported as `unreachable`.
 * @spec ING-RPC-001, ING-RPC-002, ING-RPC-003
 */
export async function validateVenuePools(venue: PoolVenue, addresses: readonly string[], rpc: RpcHttp, decoder: FrameDecoder): Promise<VenueValidation> {
  const r = await rpc.getMultipleAccounts(addresses);
  if (!r.ok) return { kind: 'unreachable', failure: r.failure };
  const problems: PoolProblem[] = [];
  const decoded = new Map<string, { mintA: string; mintB: string; decimalsA?: number; decimalsB?: number }>();
  r.value.accounts.forEach((acc, i) => {
    const address = addresses[i]!;
    if (!acc) return problems.push({ address, message: `pool ${address} was not found on-chain` });
    if (acc.owner !== PROGRAM_IDS[venue]) return problems.push({ address, message: `pool ${address} is owned by ${acc.owner}, not the ${venue} program ${PROGRAM_IDS[venue]}` });
    const d = decoder.decodeAccount(acc.data, venue);
    if (d.status !== Status.ACCOUNT || !d.info) return problems.push({ address, message: `pool ${address} does not decode as a ${venue} pool (status ${d.status})` });
    decoded.set(address, d.info);
  });

  const decimals = new Map<string, number>();
  const needMints = [...new Set([...decoded.values()].filter((p) => p.decimalsA === undefined).flatMap((p) => [p.mintA, p.mintB]))];
  if (needMints.length) {
    const m = await rpc.getMultipleAccounts(needMints);
    if (!m.ok) return { kind: 'unreachable', failure: m.failure };
    m.value.accounts.forEach((acc, i) => {
      if (acc && TOKEN_PROGRAMS.has(acc.owner) && acc.data.length >= MINT_MIN_LEN) decimals.set(needMints[i]!, acc.data[MINT_DECIMALS_OFFSET]!);
    });
  }

  const facts = new Map<string, PoolFacts>();
  for (const [address, p] of decoded) {
    const decimalsA = p.decimalsA ?? decimals.get(p.mintA);
    const decimalsB = p.decimalsB ?? decimals.get(p.mintB);
    if (decimalsA === undefined || decimalsB === undefined) {
      problems.push({ address, message: `pool ${address}: mint decimals unavailable for ${decimalsA === undefined ? p.mintA : p.mintB}` });
      continue;
    }
    facts.set(address, { address, venue, mintA: p.mintA, mintB: p.mintB, decimalsA, decimalsB });
  }
  return { kind: 'checked', facts, problems };
}
