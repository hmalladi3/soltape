import type { Clock } from '@soltape/shared';
import type { Logger } from './logger.js';

/**
 * Rate-limited warnings per (component, code): the first occurrence is logged immediately;
 * repeats are counted and summarised at most once per `windowMs`
 * ("decode_error -3 x 412 in last 10s"). Exact counts live in metrics.
 * @spec OBS-LOG-003, OBS-LOG-002
 */
export class RateLimitedLog {
  private readonly keys = new Map<string, { suppressed: number; windowStart: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: Logger,
    private readonly clock: Clock,
    private readonly windowMs = 10_000,
  ) {}

  warn(kind: string, code: string, fields: Record<string, unknown>, msg: string): void {
    const key = `${kind}:${code}`;
    const k = this.keys.get(key);
    if (!k) {
      this.keys.set(key, { suppressed: 0, windowStart: this.clock.mono() });
      this.log.warn({ ...fields, kind }, msg);
      this.ensureTimer();
      return;
    }
    k.suppressed++;
  }

  /** Emits summaries for windows that have elapsed. Called by the timer (and tests). */
  sweep(): void {
    const now = this.clock.mono();
    for (const [key, k] of this.keys) {
      if (now - k.windowStart < this.windowMs) continue;
      if (k.suppressed > 0) {
        const [kind, code] = key.split(':');
        this.log.warn({ kind, code, count: k.suppressed, windowMs: this.windowMs }, `${kind} ${code} x ${k.suppressed} in last ${Math.round(this.windowMs / 1000)}s`);
        k.suppressed = 0;
        k.windowStart = now;
      } else {
        this.keys.delete(key);
      }
    }
    if (this.keys.size === 0) this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.min(1000, this.windowMs));
    this.timer.unref();
  }
}
