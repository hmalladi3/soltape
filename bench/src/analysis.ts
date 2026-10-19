import hdr from 'hdr-histogram-js';

/** What a load client reports for one recorded (sampled) socket. */
export interface SocketReceipts {
  /** process.hrtime.bigint() of the client process at its start, as a decimal string. */
  baseNs: string;
  /** trigger.slot of each price message received. */
  slots: Float64Array;
  /** Receive time of each message in ns relative to `baseNs`. */
  recvNs: Float64Array;
}

/** The replay server's send log for one run. */
export interface SendLog {
  t0Ns: bigint;
  warmupMs: number;
  slots: Float64Array;
  intendedNs: Float64Array;
}

export function parseSendLog(buf: ArrayBuffer, headers: Headers): SendLog {
  const n = Number(headers.get('x-count'));
  const v = new DataView(buf);
  const slots = new Float64Array(n);
  const intendedNs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    slots[i] = v.getFloat64(i * 16, true);
    intendedNs[i] = v.getFloat64(i * 16 + 8, true);
  }
  return { t0Ns: BigInt(headers.get('x-t0-ns') ?? '0'), warmupMs: Number(headers.get('x-warmup-ms') ?? 0), slots, intendedNs };
}

export interface E2EResult {
  /** Microseconds. */
  p50: number;
  p99: number;
  p999: number;
  max: number;
  samples: number;
  /** Fraction of measured inputs that never reached a sampled socket (conflated away). */
  conflationRatio: number;
  measuredInputs: number;
}

/**
 * Joins client receipts to the send log by trigger slot (unique per frame in rate mode):
 * latency = client receive time − the frame's *intended* send time (both CLOCK_MONOTONIC on
 * the same host). Inputs inside the warmup window are discarded. Inputs that no sampled
 * socket received count as conflated, separately from latency.
 * @spec RPL-BEN-003, RPL-BEN-004
 */
export function joinLatencies(log: SendLog, sockets: SocketReceipts[]): E2EResult {
  const warmupNs = log.warmupMs * 1e6;
  const intendedBySlot = new Map<number, number>();
  for (let i = 0; i < log.slots.length; i++) if (log.intendedNs[i]! >= warmupNs) intendedBySlot.set(log.slots[i]!, log.intendedNs[i]!);
  const h = hdr.build({ lowestDiscernibleValue: 1, highestTrackableValue: 60_000_000, numberOfSignificantValueDigits: 3, useWebAssembly: false });
  let receivedTotal = 0;
  for (const s of sockets) {
    const offset = Number(BigInt(s.baseNs) - log.t0Ns); // client base relative to replay t0, ns
    const seen = new Set<number>();
    for (let i = 0; i < s.slots.length; i++) {
      const intended = intendedBySlot.get(s.slots[i]!);
      if (intended === undefined || seen.has(s.slots[i]!)) continue;
      seen.add(s.slots[i]!);
      const latencyNs = offset + s.recvNs[i]! - intended;
      h.recordValue(Math.max(1, Math.min(60_000_000, Math.round(latencyNs / 1000))));
    }
    receivedTotal += seen.size;
  }
  const measured = intendedBySlot.size;
  const expected = measured * sockets.length;
  const r: E2EResult = {
    p50: h.getValueAtPercentile(50),
    p99: h.getValueAtPercentile(99),
    p999: h.getValueAtPercentile(99.9),
    max: h.maxValue,
    samples: h.totalCount,
    conflationRatio: expected === 0 ? 0 : 1 - receivedTotal / expected,
    measuredInputs: measured,
  };
  h.destroy();
  return r;
}

export interface CellResult {
  rate: number;
  subscribers: number;
  e2e: E2EResult;
  internal: { p50: number; p99: number; p999: number };
  eventLoopP99Ms: number;
  rssMb: number;
  gcPauseMs: number;
  persistDrops: number;
  persistence: string;
}

export const KNEE_LIMITS = { e2eP99Us: 1000, conflation: 0.01, eventLoopP99Ms: 1 };

/**
 * The knee: the lowest rate at which end-to-end p99 exceeds 1 ms, conflation exceeds 1%, or
 * event-loop delay p99 exceeds 1 ms. Reported per subscriber count; null if never reached.
 * @spec RPL-BEN-007
 */
export function knee(cells: CellResult[]): Map<number, { rate: number; reason: string } | null> {
  const out = new Map<number, { rate: number; reason: string } | null>();
  for (const s of [...new Set(cells.map((c) => c.subscribers))]) {
    const sorted = cells.filter((c) => c.subscribers === s).sort((a, b) => a.rate - b.rate);
    const hit = sorted.find((c) => c.e2e.p99 > KNEE_LIMITS.e2eP99Us || c.e2e.conflationRatio > KNEE_LIMITS.conflation || c.eventLoopP99Ms > KNEE_LIMITS.eventLoopP99Ms);
    out.set(
      s,
      hit
        ? {
            rate: hit.rate,
            reason:
              hit.e2e.p99 > KNEE_LIMITS.e2eP99Us ? `e2e p99 ${(hit.e2e.p99 / 1000).toFixed(2)} ms` : hit.e2e.conflationRatio > KNEE_LIMITS.conflation ? `conflation ${(hit.e2e.conflationRatio * 100).toFixed(1)}%` : `event-loop p99 ${hit.eventLoopP99Ms.toFixed(2)} ms`,
          }
        : null,
    );
  }
  return out;
}

/** Reads one value (summed over matching series) from Prometheus text. */
export function promValue(text: string, metric: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  let found = false;
  for (const line of text.split('\n')) {
    if (!(line.startsWith(metric + '{') || line.startsWith(metric + ' '))) continue;
    if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    sum += Number(line.split(' ').at(-1));
    found = true;
  }
  return found ? sum : Number.NaN;
}
