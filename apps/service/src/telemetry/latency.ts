import type { Clock } from '@soltape/shared';
import hdr from 'hdr-histogram-js';

export interface LatencySummary {
  /** Microseconds. */
  p50: number;
  p99: number;
  p999: number;
  max: number;
  count: number;
  /** Emitted updates per second over the window. */
  ratePerSec: number;
  windowMs: number;
}

/**
 * Exact tail percentiles of internal latency over a rolling window: two HDR histograms
 * (3 significant digits, 1 µs–10 s), the current one and the last complete one, swapped
 * every `windowMs`. Recording is O(1) and allocation-free.
 * @spec OBS-LAT-006
 */
export class LatencyWindow {
  private current = this.make();
  private previous = this.make();
  private windowStart: number;

  constructor(
    private readonly clock: Clock,
    private readonly windowMs = 10_000,
  ) {
    this.windowStart = clock.mono();
  }

  /** Records one latency sample in milliseconds. */
  record(ms: number): void {
    this.rotate();
    this.current.recordValue(Math.max(1, Math.min(10_000_000, Math.round(ms * 1000))));
  }

  summary(): LatencySummary {
    this.rotate();
    const merged = this.make();
    merged.add(this.previous);
    merged.add(this.current);
    const elapsed = this.clock.mono() - this.windowStart + (this.previous.totalCount > 0 ? this.windowMs : 0);
    const s: LatencySummary = {
      p50: merged.getValueAtPercentile(50),
      p99: merged.getValueAtPercentile(99),
      p999: merged.getValueAtPercentile(99.9),
      max: merged.maxValue,
      count: merged.totalCount,
      ratePerSec: elapsed > 0 ? (merged.totalCount / elapsed) * 1000 : 0,
      windowMs: elapsed,
    };
    merged.destroy();
    return s;
  }

  private rotate(): void {
    const now = this.clock.mono();
    if (now - this.windowStart < this.windowMs) return;
    const old = this.previous;
    this.previous = this.current;
    this.current = old;
    this.current.reset();
    // If more than one window passed with no samples, the previous one is stale too.
    if (now - this.windowStart >= 2 * this.windowMs) this.previous.reset();
    this.windowStart = now;
  }

  private make() {
    return hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 10_000_000, numberOfSignificantValueDigits: 3, bitBucketSize: 'packed', useWebAssembly: false });
  }
}
