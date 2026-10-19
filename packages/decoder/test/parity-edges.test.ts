import { describe, expect, it } from 'vitest';
import { Status } from '../src/contract.js';
import { referenceDecoder } from '../src/reference.js';
import { accountFrame, bytes, fixtures, nativeDecoder, newOut, slotFrame } from './helpers.js';

const wp = fixtures.pools[0]!.data;
const good = accountFrame(wp);

/** Runs both decoders; returns [native, reference] status + slot 0..6 bit patterns. */
function run(text: string | Uint8Array) {
  const frame = typeof text === 'string' ? bytes(text) : text;
  const go = (d: typeof nativeDecoder) => {
    const out = newOut();
    const s = d.decodeNotification(frame, out);
    return [s, ...Array.from(new BigUint64Array(out.buffer).subarray(0, s === Status.ACCOUNT ? 7 : s === Status.SLOT ? 2 : 1), (x) => x.toString(16))];
  };
  return { native: go(nativeDecoder), reference: go(referenceDecoder) };
}

const cases: [string, string | Uint8Array, number][] = [
  // Duplicate keys resolve last-wins, as in JSON.parse.
  ['duplicate method: last wins', good.replace('"method":"accountNotification"', '"method":"x","method":"accountNotification"'), Status.ACCOUNT],
  ['duplicate method: last loses', good.replace('"method":"accountNotification"', '"method":"accountNotification","method":"x"'), Status.OTHER],
  ['duplicate subscription', good.replace('"subscription":42', '"subscription":"bad","subscription":42'), Status.ACCOUNT],
  // Escapes.
  ['escaped key', good.replace('"method"', '"\\u006dethod"'), Status.ACCOUNT],
  ['escaped method value', good.replace('"accountNotification"', '"account\\u004eotification"'), Status.ACCOUNT],
  ['escaped base64 text', good.replace(`"${wp.slice(0, 4)}`, `"\\u00${wp.charCodeAt(0).toString(16)}${wp.slice(1, 4)}`), Status.ACCOUNT],
  ['escaped encoding name', good.replace('"base64"]', '"base\\u00364"]'), Status.ACCOUNT],
  // Unpaired surrogates.
  ['lone surrogate in method', good.replace('"accountNotification"', '"\\ud800"'), Status.OTHER],
  ['lone surrogate in base64 text', accountFrame('', { data: ['\ud800', 'base64'] }).replace(/\ud800/, '\\ud800'), Status.BAD_ENCODING],
  ['lone surrogate in encoding', good.replace('"base64"]', '"\\udc00"]'), Status.BAD_ENCODING],
  ['lone surrogate in unknown top-level value', good.replace('"jsonrpc":"2.0"', '"jsonrpc":"\\ud800"'), Status.ACCOUNT],
  ['lone surrogate in ignored nested value', good.replace('"owner":', '"x":{"y":["\\ud800"]},"owner":'), Status.ACCOUNT],
  ['lone surrogate in top-level key', good.replace('"jsonrpc"', '"\\ud800"'), Status.MALFORMED_JSON],
  ['lone surrogate in params key', good.replace('"subscription"', '"\\ud800":1,"subscription"'), Status.MALFORMED_JSON],
  ['lone surrogate in value key', good.replace('"owner"', '"\\ud800"'), Status.MALFORMED_JSON],
  ['lone surrogate string as params', '{"method":"accountNotification","params":"\\ud800"}', Status.MALFORMED_JSON],
  ['lone surrogate string at top level', '"\\ud800"', Status.MALFORMED_JSON],
  ['lone surrogate key in data object', accountFrame('', { data: { '\ud800': 1 } }).replace(/\ud800/, '\\ud800'), Status.MALFORMED_JSON],
  // Numbers.
  ['overflowing subscription', good.replace('"subscription":42', '"subscription":1e400'), Status.MALFORMED_JSON],
  ['overflowing ignored number', good.replace('"lamports":13645859', '"lamports":1e400'), Status.ACCOUNT],
  ['overflowing method', good.replace('"accountNotification"', '1e400'), Status.OTHER],
  ['overflowing params', '{"method":"slotNotification","params":-1e999}', Status.MALFORMED_JSON],
  ['overflowing data element', accountFrame('', { data: [1, 'base64'] }).replace('[1,', '[1e400,'), Status.BAD_ENCODING],
  ['negative zero subscription', good.replace('"subscription":42', '"subscription":-0'), Status.ACCOUNT],
  ['exponent subscription', good.replace('"subscription":42', '"subscription":4.2e1'), Status.ACCOUNT],
  ['fractional subscription', good.replace('"subscription":42', '"subscription":42.5'), Status.MALFORMED_JSON],
  ['negative slot', slotFrame(5).replace('"slot":5', '"slot":-5'), Status.MALFORMED_JSON],
  ['slot above 2^53-1', slotFrame(5).replace('"slot":5', '"slot":9007199254740992'), Status.MALFORMED_JSON],
  ['slot at 2^53-1', slotFrame(5).replace('"slot":5', '"slot":9007199254740991'), Status.SLOT],
  // Shapes and types.
  ['null data', good.replace(/"data":\[[^\]]*\]/, '"data":null'), Status.BAD_ENCODING],
  ['missing data', good.replace(/"data":\[[^\]]*\],/, ''), Status.MALFORMED_JSON],
  ['null value', '{"method":"accountNotification","params":{"result":{"context":{"slot":1},"value":null},"subscription":1}}', Status.MALFORMED_JSON],
  ['array params', '{"method":"accountNotification","params":[1,2]}', Status.MALFORMED_JSON],
  ['data with three elements', accountFrame('', { data: [wp, 'base64', 'x'] }), Status.BAD_ENCODING],
  ['data with one element', accountFrame('', { data: [wp] }), Status.BAD_ENCODING],
  ['own-property lookups only', '{"method":"slotNotification","params":{"result":{"constructor":1},"subscription":1}}', Status.MALFORMED_JSON],
  ['__proto__ key', '{"__proto__":{"method":"slotNotification"},"method":"x"}', Status.OTHER],
  // Text.
  ['leading BOM', '﻿' + good, Status.MALFORMED_JSON],
  ['surrounding whitespace', ` \n\t${good}\r\n `, Status.ACCOUNT],
  ['trailing garbage', good + 'x', Status.MALFORMED_JSON],
  ['two documents', good + good, Status.MALFORMED_JSON],
  ['deeply nested ignored value', good.replace('"owner":', `"x":${'['.repeat(2000)}${']'.repeat(2000)},"owner":`), Status.ACCOUNT],
  ['deeply nested top-level array', '['.repeat(2000) + ']'.repeat(2000), Status.OTHER],
  ['UTF-8 encoded surrogate (invalid)', Uint8Array.from([0x22, 0xed, 0xa0, 0x80, 0x22]), Status.MALFORMED_JSON],
];

describe('parity on JSON edge cases', () => {
  // @spec DEC-PAR-001, DEC-FRAME-010
  it.each(cases)('%s', (_label, frame, expected) => {
    const { native, reference } = run(frame);
    expect(reference).toEqual(native);
    expect(native[0]).toBe(expected);
  });
});
