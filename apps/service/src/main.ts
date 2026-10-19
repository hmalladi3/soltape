import { readFileSync } from 'node:fs';
import { loadConfig } from './config/load.js';
import { createAppContainer } from './container.js';

/** Process entry point: config → container → runtime. */
function main(): void {
  let marketsJson: unknown;
  const marketsFile = process.env['MARKETS_FILE'] || 'config/markets.json';
  try {
    marketsJson = JSON.parse(readFileSync(marketsFile, 'utf8'));
  } catch (err) {
    console.error(`cannot read markets file ${marketsFile}: ${(err as Error).message}`);
    process.exit(2);
  }
  const cfg = loadConfig(process.env, marketsJson);
  if (!cfg.ok) {
    console.error(`invalid configuration (${cfg.errors.length} error(s)):\n  ${cfg.errors.join('\n  ')}`);
    process.exit(2);
  }
  let container: ReturnType<typeof createAppContainer>;
  try {
    container = createAppContainer(cfg.value);
  } catch (err) {
    console.error(`startup failed: ${(err as Error).message}`);
    process.exit(2);
  }
  const runtime = container.cradle.runtime;
  runtime.install(process);
  void runtime.start();
}

main();
