import type { PoolFacts } from '../../src/markets/model.js';

export const MINT = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
} as const;

export const DEC: Record<string, number> = {
  [MINT.SOL]: 9,
  [MINT.USDC]: 6,
  [MINT.JUP]: 6,
  [MINT.JTO]: 9,
  [MINT.BONK]: 5,
  [MINT.WIF]: 6,
};

const f = (address: string, venue: 'orca' | 'raydium', mintA: string, mintB: string): PoolFacts => ({
  address,
  venue,
  mintA,
  mintB,
  decimalsA: DEC[mintA]!,
  decimalsB: DEC[mintB]!,
});

/** On-chain facts for every pool in config/markets.json, as observed on mainnet 2026-10-19. */
export const POOL_FACTS: PoolFacts[] = [
  f('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', 'orca', MINT.SOL, MINT.USDC),
  f('3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', 'raydium', MINT.SOL, MINT.USDC),
  f('C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz', 'orca', MINT.JUP, MINT.SOL),
  f('EZVkeboWeXygtq8LMyENHyXdF5wpYrtExRNH9UwB1qYw', 'raydium', MINT.JUP, MINT.SOL),
  f('2UhFnySoJi6c89aydGAGS7ZRemo2dbkFRhvSJqDX4gHJ', 'orca', MINT.SOL, MINT.JTO),
  f('JVoPtWWDsRcLvQosu5fWc2CaNF6jEtJzbxdPtcEuvZo', 'raydium', MINT.SOL, MINT.JTO),
  f('5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9', 'orca', MINT.SOL, MINT.BONK),
  f('GtKKKs3yaPdHbQd2aZS4SfWhy8zQ988BJGnKNndLxYsN', 'raydium', MINT.SOL, MINT.BONK),
  f('D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1', 'orca', MINT.SOL, MINT.WIF),
  f('4mMDQ5kG9fFrBSQeedErsUoTBhY5KKnsKWGvenXRTwSy', 'raydium', MINT.SOL, MINT.WIF),
];

export const factsMap = (facts: PoolFacts[] = POOL_FACTS): Map<string, PoolFacts> => new Map(facts.map((x) => [x.address, x]));
