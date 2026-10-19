import type { Clock } from '@soltape/shared';

export class FakeClock implements Clock {
  private monoMs = 1_000_000;
  private wallMs = Date.UTC(2026, 9, 19, 14, 0, 0);
  mono(): number {
    return this.monoMs;
  }
  wall(): number {
    return this.wallMs;
  }
  advance(ms: number): void {
    this.monoMs += ms;
    this.wallMs += ms;
  }
}
