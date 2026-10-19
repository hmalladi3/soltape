import type { SourceId } from '@soltape/shared';
import type { PoolUpdateKind, SourceSink, SourceStatus } from '../../src/reconcile/types.js';

export type SinkEvent =
  | { t: 'pool'; pool: number; sqrt: number; liq: number; tick: number; slot: number; recvTs: number; recvWall: number; decodedTs: number; kind: PoolUpdateKind }
  | { t: 'quote'; market: number; price: number; blockId: number | null; recvTs: number; recvWall: number }
  | { t: 'slot'; source: SourceId; slot: number | null; recvTs: number }
  | { t: 'state'; source: SourceId; state: string }
  | { t: 'suspect'; pool: number }
  | { t: 'misconfigured'; pool: number };

/** Records everything an adapter reports; also acts as a controllable source registry. */
export class RecordingSink implements SourceSink {
  readonly events: SinkEvent[] = [];
  status: SourceStatus = { state: 'live', lastEventAgeMs: 0, staleSince: null };

  onPoolUpdate(pool: number, sqrt: number, liq: number, tick: number, slot: number, recvTs: number, recvWall: number, decodedTs: number, kind: PoolUpdateKind): void {
    this.events.push({ t: 'pool', pool, sqrt, liq, tick, slot, recvTs, recvWall, decodedTs, kind });
  }
  onQuote(market: number, price: number, blockId: number | null, recvTs: number, recvWall: number): void {
    this.events.push({ t: 'quote', market, price, blockId, recvTs, recvWall });
  }
  onSlot(source: SourceId, slot: number | null, recvTs: number): void {
    this.events.push({ t: 'slot', source, slot, recvTs });
  }
  onSourceState(source: SourceId, state: string): void {
    this.events.push({ t: 'state', source, state });
  }
  onPoolSuspect(pool: number): void {
    this.events.push({ t: 'suspect', pool });
  }
  onPoolMisconfigured(pool: number): void {
    this.events.push({ t: 'misconfigured', pool });
  }
  sourceStatus(): SourceStatus {
    return this.status;
  }

  of<T extends SinkEvent['t']>(t: T): Extract<SinkEvent, { t: T }>[] {
    return this.events.filter((e): e is Extract<SinkEvent, { t: T }> => e.t === t);
  }
  states(): string[] {
    return this.of('state').map((e) => e.state);
  }
}
