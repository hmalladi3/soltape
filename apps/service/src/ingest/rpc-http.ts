import type { Clock } from '@soltape/shared';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { retryAfterMs } from './backoff.js';

export interface RpcAccount {
  owner: string;
  /** Raw account bytes (base64-decoded). */
  data: Buffer;
}

export type RpcFailure =
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'http'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string }
  | { kind: 'rpc'; code: number; message: string }
  | { kind: 'invalid'; message: string };

export type RpcResult<T> = { ok: true; value: T } | { ok: false; failure: RpcFailure };

export interface MultipleAccounts {
  slot: number;
  accounts: (RpcAccount | null)[];
}

export interface RpcHttp {
  getMultipleAccounts(keys: readonly string[]): Promise<RpcResult<MultipleAccounts>>;
  /** Closes pooled connections (RUN-LIFE-012). */
  close(): Promise<void>;
}

const accountSchema = z.object({ owner: z.string(), data: z.tuple([z.string(), z.literal('base64')]) }).nullable();
const responseSchema = z.union([
  z.object({ result: z.object({ context: z.object({ slot: z.number().int().nonnegative() }), value: z.array(accountSchema) }) }),
  z.object({ error: z.object({ code: z.number(), message: z.string() }) }),
]);

/** getMultipleAccounts accepts at most 100 keys per call. */
const MAX_KEYS = 100;

/**
 * Minimal Solana JSON-RPC HTTP client. Every failure is returned as a value, never thrown.
 * @spec RUN-ERR-002
 */
export class RpcHttpClient implements RpcHttp {
  /** Own keep-alive pool, so shutdown can close it. */
  private readonly agent = new Agent({ keepAliveTimeout: 30_000 });

  constructor(
    private readonly opts: { url: string; commitment: string; timeoutMs: number; clock: Clock; fetch?: typeof fetch },
  ) {}

  async close(): Promise<void> {
    await this.agent.close();
  }

  async getMultipleAccounts(keys: readonly string[]): Promise<RpcResult<MultipleAccounts>> {
    const accounts: (RpcAccount | null)[] = [];
    let slot = Number.POSITIVE_INFINITY;
    for (let i = 0; i < keys.length; i += MAX_KEYS) {
      const r = await this.call(keys.slice(i, i + MAX_KEYS));
      if (!r.ok) return r;
      accounts.push(...r.value.accounts);
      slot = Math.min(slot, r.value.slot);
    }
    return { ok: true, value: { slot: Number.isFinite(slot) ? slot : 0, accounts } };
  }

  private async call(keys: string[]): Promise<RpcResult<MultipleAccounts>> {
    // undici's own fetch: its Agent's dispatcher API must match the fetch implementation.
    const f = this.opts.fetch ?? (undiciFetch as unknown as typeof fetch);
    let res: Response;
    try {
      res = await f(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: this.opts.commitment }] }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        dispatcher: this.agent,
      } as unknown as RequestInit);
    } catch (err) {
      return { ok: false, failure: isTimeout(err) ? { kind: 'timeout' } : { kind: 'network', message: String((err as Error).message ?? err) } };
    }
    if (res.status === 429) {
      await res.body?.cancel();
      return { ok: false, failure: { kind: 'rate_limited', retryAfterMs: retryAfterMs(res.headers.get('retry-after'), this.opts.clock.wall()) } };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, failure: { kind: 'http', status: res.status } };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, failure: isTimeout(err) ? { kind: 'timeout' } : { kind: 'invalid', message: 'response is not JSON' } };
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return { ok: false, failure: { kind: 'invalid', message: 'unexpected getMultipleAccounts response shape' } };
    if ('error' in parsed.data) return { ok: false, failure: { kind: 'rpc', ...parsed.data.error } };
    const { context, value } = parsed.data.result;
    if (value.length !== keys.length) return { ok: false, failure: { kind: 'invalid', message: 'account count mismatch' } };
    return {
      ok: true,
      value: { slot: context.slot, accounts: value.map((a) => (a ? { owner: a.owner, data: Buffer.from(a.data[0], 'base64') } : null)) },
    };
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
