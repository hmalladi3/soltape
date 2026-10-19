import type { Consolidated, ObservationView } from '../reconcile/types.js';

export type RestConsolidated = Omit<Consolidated, 'trigger'>;

/** REST/WS `data` shape: the consolidated record without its trigger. */
export function restConsolidated(c: Consolidated): RestConsolidated {
  const { trigger: _trigger, ...rest } = c;
  return rest;
}

export interface RestObservation extends Omit<ObservationView, 'receivedAt'> {
  receivedAt: string | null;
}

export function restObservation(o: ObservationView): RestObservation {
  return { ...o, receivedAt: o.receivedAt === null ? null : new Date(o.receivedAt).toISOString() };
}
