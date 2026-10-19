/**
 * Full-jitter exponential backoff: `random(0, min(cap, base × 2^attempt))`.
 * @spec ING-RPC-042
 */
export function fullJitter(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  return random() * Math.min(capMs, baseMs * 2 ** attempt);
}

/** Parses an HTTP `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null, nowWall: number): number | null {
  if (header === null || header.trim() === '') return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - nowWall);
}
