import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeAccount {
  owner: string;
  data: Buffer;
}

type Confirm = 'ok' | 'error' | 'ignore';

/**
 * A local stand-in for a Solana RPC node: JSON-RPC over HTTP (getMultipleAccounts) and
 * WebSocket (slotSubscribe, accountSubscribe), with knobs for fault injection.
 */
export class FakeRpc {
  readonly accounts = new Map<string, FakeAccount>();
  slot = 1000;
  /** Every JSON-RPC request received (HTTP and WS). */
  readonly requests: { transport: 'http' | 'ws'; method: string; params: unknown }[] = [];
  readonly sockets = new Set<WebSocket>();
  connections = 0;
  pings = 0;
  /** Decides how each subscribe request is answered. */
  confirm: (method: string, params: unknown) => Confirm = () => 'ok';
  /** HTTP behaviour: normal, a status code (e.g. 429), or `down` (connection destroyed). */
  http: 'ok' | 'down' | { status: number; retryAfter?: string } = 'ok';
  acceptConnections = true;
  autoPong = true;

  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private nextSub = 100;
  private readonly subs = new Map<number, { ws: WebSocket; kind: 'slot' | 'account'; address?: string }>();

  private constructor() {
    this.server = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, autoPong: false });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.acceptConnections) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  static async start(): Promise<FakeRpc> {
    const f = new FakeRpc();
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
    return f;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }
  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  setAccount(address: string, owner: string, data: Buffer | string): void {
    this.accounts.set(address, { owner, data: typeof data === 'string' ? Buffer.from(data, 'base64') : data });
  }

  subscribers(kind: 'slot' | 'account', address?: string): number {
    return [...this.subs.values()].filter((s) => s.kind === kind && (address === undefined || s.address === address)).length;
  }

  /** Sends an accountNotification for `address` to its subscribers (data defaults to the stored account). */
  pushAccount(address: string, opts: { data?: Buffer; slot?: number } = {}): void {
    const slot = opts.slot ?? ++this.slot;
    const acc = this.accounts.get(address)!;
    const data = opts.data ?? acc.data;
    if (opts.data) this.accounts.set(address, { ...acc, data });
    for (const [id, s] of this.subs) {
      if (s.kind !== 'account' || s.address !== address) continue;
      s.ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'accountNotification',
          params: {
            result: { context: { slot }, value: { data: [data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: acc.owner, rentEpoch: 0, space: data.length } },
            subscription: id,
          },
        }),
      );
    }
  }

  pushSlot(slot = ++this.slot): void {
    for (const [id, s] of this.subs) {
      if (s.kind === 'slot') s.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'slotNotification', params: { result: { parent: slot - 1, root: slot - 32, slot }, subscription: id } }));
    }
  }

  /** Sends a raw frame to every account subscriber of `address` (or every socket). */
  sendRaw(frame: string | Buffer, address?: string): void {
    const targets = address ? [...this.subs.values()].filter((s) => s.address === address).map((s) => s.ws) : [...this.sockets];
    for (const ws of new Set(targets)) ws.send(frame);
  }

  subscriptionId(address: string): number | undefined {
    for (const [id, s] of this.subs) if (s.address === address) return id;
    return undefined;
  }

  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  count(method: string): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private onConnection(ws: WebSocket): void {
    this.connections++;
    this.sockets.add(ws);
    ws.on('ping', (data) => {
      this.pings++;
      if (this.autoPong) ws.pong(data);
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      for (const [id, s] of this.subs) if (s.ws === ws) this.subs.delete(id);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown[] };
      this.requests.push({ transport: 'ws', method: msg.method, params: msg.params });
      const decision = this.confirm(msg.method, msg.params);
      if (decision === 'ignore') return;
      if (decision === 'error') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32005, message: 'subscription limit' }, id: msg.id }));
        return;
      }
      const sub = this.nextSub++;
      if (msg.method === 'slotSubscribe') this.subs.set(sub, { ws, kind: 'slot' });
      else if (msg.method === 'accountSubscribe') this.subs.set(sub, { ws, kind: 'account', address: String(msg.params?.[0]) });
      ws.send(JSON.stringify({ jsonrpc: '2.0', result: sub, id: msg.id }));
    });
  }

  private async onHttp(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: [string[], unknown] };
    this.requests.push({ transport: 'http', method: body.method, params: body.params });
    if (this.http === 'down') return void req.socket.destroy();
    if (this.http !== 'ok') {
      res.writeHead(this.http.status, this.http.retryAfter ? { 'retry-after': this.http.retryAfter } : {});
      return void res.end();
    }
    const value = body.params[0].map((k) => {
      const a = this.accounts.get(k);
      return a ? { data: [a.data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: a.owner, rentEpoch: 0, space: a.data.length } : null;
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', result: { context: { slot: this.slot }, value }, id: body.id }));
  }
}

/** Polls `fn` until it returns truthy or the timeout elapses. */
export async function waitFor<T>(fn: () => T, timeoutMs = 2000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
