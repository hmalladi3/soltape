import WebSocket from 'ws';

/**
 * Load-client process: opens `subs` WebSocket subscribers subscribed to every market. The first
 * `sampled` sockets record (trigger slot, receive time) for each price message; the rest only
 * consume. Reports to the parent over IPC when told to stop.
 * @spec RPL-BEN-001, RPL-BEN-002
 */
const [url = '', subsArg = '1', sampledArg = '4'] = process.argv.slice(2);
const subs = Number(subsArg);
const sampled = Math.min(subs, Number(sampledArg));
const baseNs = process.hrtime.bigint();

class Growable {
  a = new Float64Array(1 << 16);
  n = 0;
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  view(): Float64Array {
    return this.a.slice(0, this.n);
  }
}

const recs = Array.from({ length: sampled }, () => ({ slots: new Growable(), recv: new Growable() }));
let recording = false;
let consumed = 0;
const sockets: WebSocket[] = [];
let open = 0;

for (let i = 0; i < subs; i++) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  sockets.push(ws);
  const rec = recs[i];
  ws.on('open', () => {
    ws.send(JSON.stringify({ op: 'subscribe', mints: ['*'] }));
    if (++open === subs) process.send?.({ type: 'ready' });
  });
  ws.on('message', (data: Buffer) => {
    const t = process.hrtime.bigint();
    consumed++;
    if (!rec || !recording) return;
    // Cheap extraction of trigger.slot without parsing the whole message.
    const s = data.toString('latin1');
    const k = s.lastIndexOf('"slot":');
    if (k < 0 || !s.startsWith('{"type":"price"')) return;
    const slot = Number.parseInt(s.slice(k + 7), 10);
    if (!Number.isFinite(slot)) return;
    rec.slots.push(slot);
    rec.recv.push(Number(t - baseNs));
  });
  ws.on('error', () => undefined);
}

process.on('message', (m: { type: string }) => {
  if (m.type === 'record') recording = true;
  if (m.type === 'stop') {
    recording = false;
    process.send?.({ type: 'result', consumed, sockets: recs.map((r) => ({ baseNs: baseNs.toString(), slots: r.slots.view(), recvNs: r.recv.view() })) }, () => {
      for (const ws of sockets) ws.terminate();
      process.exit(0);
    });
  }
});
