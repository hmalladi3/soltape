import { describe, expect, it } from 'vitest';
import { Layout, MAX_ACCOUNT_LEN, Out, Status } from '../src/contract.js';
import { accountFrame, bytes, implementations, newOut, raydiumPools, resized, slotFrame, u128, whirlpools, withI32, withU128 } from './helpers.js';

const wp = whirlpools[0]!;
const rp = raydiumPools[0]!;

describe.each(implementations)('decodeNotification (%s)', (_name, dec) => {
  // @spec DEC-FRAME-001
  it('decodes a Whirlpool account notification into slots 0-6', () => {
    const out = newOut();
    const b = Buffer.from(wp.data, 'base64');
    const status = dec.decodeNotification(bytes(accountFrame(wp.data, { sub: 42, slot: 372000123 })), out);
    expect(status).toBe(Status.ACCOUNT);
    expect(out[Out.SUB]).toBe(42);
    expect(out[Out.SLOT]).toBe(372000123);
    expect(out[Out.LAYOUT]).toBe(Layout.WHIRLPOOL);
    expect(out[Out.SQRT]).toBe(Number(u128(b, 65)) * 2 ** -64);
    expect(out[Out.LIQ]).toBe(Number(u128(b, 49)));
    expect(out[Out.TICK]).toBe(b.readInt32LE(81));
    expect(out[Out.SIZE_UNEXPECTED]).toBe(0);
  });

  // @spec DEC-FRAME-001
  it('decodes a Raydium CLMM account notification into slots 0-6', () => {
    const out = newOut();
    const b = Buffer.from(rp.data, 'base64');
    const status = dec.decodeNotification(bytes(accountFrame(rp.data, { sub: 9, slot: 5 })), out);
    expect(status).toBe(Status.ACCOUNT);
    expect(out[Out.SUB]).toBe(9);
    expect(out[Out.SLOT]).toBe(5);
    expect(out[Out.LAYOUT]).toBe(Layout.RAYDIUM_CLMM);
    expect(out[Out.SQRT]).toBe(Number(u128(b, 253)) * 2 ** -64);
    expect(out[Out.LIQ]).toBe(Number(u128(b, 237)));
    expect(out[Out.TICK]).toBe(b.readInt32LE(269));
    expect(out[Out.SIZE_UNEXPECTED]).toBe(0);
  });

  // @spec DEC-FRAME-002
  it('decodes a slot notification into slots 0-1', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes(slotFrame(458950024, 3)), out)).toBe(Status.SLOT);
    expect(out[Out.SUB]).toBe(3);
    expect(out[Out.SLOT]).toBe(458950024);
  });

  // @spec DEC-FRAME-003
  it.each([
    ['subscription confirmation', '{"jsonrpc":"2.0","result":12,"id":1}'],
    ['json-rpc error', '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"},"id":4}'],
    ['unknown method', '{"jsonrpc":"2.0","method":"rootNotification","params":{"result":5,"subscription":1}}'],
    ['bare number', '123'],
    ['array', '[1,2,3]'],
  ])('returns OTHER for %s', (_label, frame) => {
    expect(dec.decodeNotification(bytes(frame), newOut())).toBe(Status.OTHER);
  });

  // @spec DEC-FRAME-004
  it.each([
    ['truncated JSON', accountFrame(wp.data).slice(0, 120)],
    ['empty input', ''],
    ['not JSON', 'hello'],
    ['subscription is a string', accountFrame(wp.data, { sub: 'x' })],
    ['slot is a string', accountFrame(wp.data, { slot: '5' })],
    ['slot notification without slot', '{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{},"subscription":1}}'],
  ])('returns MALFORMED_JSON for %s', (_label, frame) => {
    expect(dec.decodeNotification(bytes(frame), newOut())).toBe(Status.MALFORMED_JSON);
  });

  // @spec DEC-FRAME-004
  it('returns MALFORMED_JSON for invalid UTF-8', () => {
    const frame = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    expect(dec.decodeNotification(frame, newOut())).toBe(Status.MALFORMED_JSON);
  });

  // @spec DEC-FRAME-005
  it.each([
    ['data is a string', { data: wp.data }],
    ['encoding is jsonParsed', { data: [wp.data, 'jsonParsed'] }],
    ['encoding missing', { data: [wp.data] }],
    ['invalid base64 character', { data: [wp.data.slice(0, -4) + '*AAA', 'base64'] }],
    ['missing padding', { data: [wp.data.replace(/=+$/, ''), 'base64'] }],
    ['embedded whitespace', { data: [wp.data.slice(0, 40) + ' ' + wp.data.slice(40), 'base64'] }],
  ])('returns BAD_ENCODING when %s', (_label, opts) => {
    expect(dec.decodeNotification(bytes(accountFrame(wp.data, opts)), newOut())).toBe(Status.BAD_ENCODING);
  });

  // @spec DEC-FRAME-006
  it.each([
    ['Whirlpool below minimum length', resized(wp.data, 212)],
    ['Raydium below minimum length', resized(rp.data, 272)],
    ['shorter than a discriminator', Buffer.from([1, 2, 3]).toString('base64')],
    ['longer than 4 KiB', resized(wp.data, MAX_ACCOUNT_LEN + 1)],
  ])('returns BAD_LENGTH for %s', (_label, data) => {
    expect(dec.decodeNotification(bytes(accountFrame(data)), newOut())).toBe(Status.BAD_LENGTH);
  });

  // @spec DEC-FRAME-007
  it('returns UNKNOWN_LAYOUT for an unrecognised discriminator', () => {
    const b = Buffer.from(wp.data, 'base64');
    b.fill(0xab, 0, 8);
    expect(dec.decodeNotification(bytes(accountFrame(b.toString('base64'))), newOut())).toBe(Status.UNKNOWN_LAYOUT);
  });

  // @spec DEC-FRAME-008
  it.each([
    ['Whirlpool sqrt price of zero', withU128(wp.data, 65, 0n)],
    ['Whirlpool sqrt price above max', withU128(wp.data, 65, 79226673515401279992447579056n)],
    ['Whirlpool tick below min', withI32(wp.data, 81, -443637)],
    ['Raydium sqrt price below min', withU128(rp.data, 253, 4295048015n)],
    ['Raydium tick above max', withI32(rp.data, 269, 443637)],
  ])('returns INVALID_VALUE for %s', (_label, data) => {
    expect(dec.decodeNotification(bytes(accountFrame(data)), newOut())).toBe(Status.INVALID_VALUE);
  });

  // @spec DEC-FRAME-008
  it('accepts zero liquidity', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(withU128(wp.data, 49, 0n))), out)).toBe(Status.ACCOUNT);
    expect(out[Out.LIQ]).toBe(0);
  });

  // @spec DEC-FRAME-009
  it('writes the subscription id when the payload is bad but the id is recoverable', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(resized(wp.data, 100), { sub: 77 })), out)).toBe(Status.BAD_LENGTH);
    expect(out[Out.SUB]).toBe(77);
  });

  // @spec DEC-FRAME-009
  it('writes -1 as the subscription id when the frame is malformed', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes('{"jsonrpc":'), out)).toBe(Status.MALFORMED_JSON);
    expect(out[Out.SUB]).toBe(-1);
  });

  // @spec DEC-FRAME-010
  it('is independent of key order and ignores unknown fields', () => {
    const a = newOut();
    const b = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(wp.data)), a)).toBe(Status.ACCOUNT);
    const frame = accountFrame(wp.data, { reverseKeys: true, extra: { unknown: { nested: [1, 2] } } });
    expect(dec.decodeNotification(bytes(frame), b)).toBe(Status.ACCOUNT);
    expect(Array.from(b.subarray(0, 7))).toEqual(Array.from(a.subarray(0, 7)));
  });

  // @spec DEC-FRAME-011
  it('decodes accounts longer than documented and flags the size', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(resized(wp.data, 653 + 64))), out)).toBe(Status.ACCOUNT);
    expect(out[Out.SIZE_UNEXPECTED]).toBe(1);
  });

  // @spec DEC-FRAME-011
  it('decodes accounts shorter than documented but above minimum and flags the size', () => {
    const out = newOut();
    expect(dec.decodeNotification(bytes(accountFrame(resized(rp.data, 400))), out)).toBe(Status.ACCOUNT);
    expect(out[Out.SIZE_UNEXPECTED]).toBe(1);
  });
});
