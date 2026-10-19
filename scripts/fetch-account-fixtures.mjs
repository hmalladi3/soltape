// Fetches the pool and mint accounts referenced by config/markets.json from mainnet and
// writes them as decoder fixtures. Usage: node scripts/fetch-account-fixtures.mjs [rpcUrl]
import { readFile, writeFile } from 'node:fs/promises';

const rpc = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const markets = JSON.parse(await readFile(new URL('../config/markets.json', import.meta.url), 'utf8'));

const pools = new Set();
const mints = new Set([markets.quote.mint]);
for (const m of markets.markets) {
  mints.add(m.mint);
  for (const [venue, v] of Object.entries(m.venues)) {
    if (venue === 'jupiter') continue;
    for (const p of v.pool ? [v.pool] : v.route) pools.add(p);
  }
}
mints.add('So11111111111111111111111111111111111111112');

async function getMultiple(keys) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

const poolKeys = [...pools];
const mintKeys = [...mints];
const [p, m] = [await getMultiple(poolKeys), await getMultiple(mintKeys)];
const toEntry = (key, v, slot) => ({ address: key, slot, owner: v.owner, space: v.space, data: v.data[0] });
const out = {
  fetchedAt: new Date().toISOString(),
  pools: poolKeys.map((k, i) => toEntry(k, p.value[i], p.context.slot)),
  mints: mintKeys.map((k, i) => toEntry(k, m.value[i], m.context.slot)),
};
await writeFile(new URL('../packages/decoder/fixtures/accounts.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.pools.length} pools, ${out.mints.length} mints at slot ${p.context.slot}`);
