import { readFileSync } from 'node:fs';
import { loadConfig } from './config/load.js';
import { createAppContainer } from './container.js';
import { pino } from 'pino';
import { createLogger } from './telemetry/logger.js';

/** Process entry point: config → container → runtime. */
function main(): void {
  // Before config is valid, log structured lines at info level (OBS-LOG-001).
  // Synchronous destination: the process may exit immediately after a fatal line.
  const boot = createLogger(process.env['LOG_LEVEL'] || 'info', pino.destination({ sync: true })).child({ component: 'config' });
  const fail = (msg: string, errors: string[] = []) => {
    boot.fatal({ errors }, msg);
    console.error([msg, ...errors.map((e) => `  ${e}`)].join('\n'));
    process.exit(2);
  };
  let marketsJson: unknown;
  const marketsFile = process.env['MARKETS_FILE'] || 'config/markets.json';
  try {
    marketsJson = JSON.parse(readFileSync(marketsFile, 'utf8'));
  } catch (err) {
    return fail(`cannot read markets file ${marketsFile}: ${(err as Error).message}`);
  }
  const cfg = loadConfig(process.env, marketsJson);
  if (!cfg.ok) return fail(`invalid configuration (${cfg.errors.length} error(s))`, cfg.errors);
  let container: ReturnType<typeof createAppContainer>;
  try {
    container = createAppContainer(cfg.value);
  } catch (err) {
    return fail(`startup failed: ${(err as Error).message}`);
  }
  const runtime = container.cradle.runtime;
  runtime.install(process);
  void runtime.start();
}

main();
