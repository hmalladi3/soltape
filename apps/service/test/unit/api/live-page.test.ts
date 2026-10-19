import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));

describe('live page', () => {
  // @spec API-UI-001
  it('is a single self-contained file with no external scripts, styles or fonts', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/import\s|require\(/);
  });

  // @spec API-UI-002
  it('renders a row per market with price, flags, the deviation strip, spread, slot and age', () => {
    for (const hook of ['buildRows', 'renderPrice', 'renderStrip', 'sources disagree', 'no eligible source', '.spread', '.slot', 'fmtAge', "classList.add(data.price > prev ? 'up' : 'down')"]) {
      expect(script).toContain(hook);
    }
    expect(script).toContain("JSON.stringify({ op: 'subscribe', mints: ['*'] })");
  });

  // @spec API-UI-003
  it('expands a row into the per-source breakdown refreshed every second', () => {
    expect(script).toContain('/sources/${m.mint}');
    expect(script).toContain('setInterval(pollSources, 1000)');
    expect(script).toContain("setAttribute('aria-expanded'");
    expect(script).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  // @spec API-UI-004
  it('polls /stats every second for latency percentiles, update rate, source states and decoder', () => {
    expect(script).toContain("fetch('/stats')");
    expect(script).toContain('setInterval(pollStats, 1000)');
    for (const f of ['latencyUs.p50', 'latencyUs.p99', 'latencyUs.p999', 'updatesPerSec', 's.decoder', 's.sources']) expect(script).toContain(f);
  });

  // @spec API-UI-005
  it('shows a disconnected banner and reconnects with capped backoff', () => {
    expect(script).toContain('Disconnected from the feed. Reconnecting in');
    expect(script).toContain('Math.min(8000, 500 * 2 ** attempt++)');
    expect(script).toContain('setTimeout(connect, delay)');
  });

  // @spec API-UI-006
  it('follows prefers-color-scheme for light and dark themes', () => {
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('color-scheme: light dark');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
