# Frame Decoder

## Context and Design Philosophy

The decoder is the only Rust in the system (HLD KDD-1, KDD-2). It turns raw bytes into numbers. On the hot path, its input is an entire JSON-RPC WebSocket notification frame. It finds the subscription id and slot, base64-decodes the account data, identifies the layout, and extracts the pool's price-bearing fields. All of this happens in one native call that creates no JS objects.

Principles:
- **Pure.** No I/O, no global mutable state, no clocks, no logging. Same bytes in, same result out. That is what makes it safe to embed in the process and possible to fuzz.
- **Never throws across the boundary.** Every failure is a negative status code. Panics are caught with `catch_unwind` and reported as `PANIC`.
- **Allocation-free hot path.** Results go into a caller-provided `Float64Array`, and the return value is a small integer. The base64 scratch space is a fixed-size stack buffer.
- **Twin implementation.** A TypeScript reference decoder implements the identical contract, and both are tested for exact parity on the same inputs.

## Package Layout

```
packages/decoder/
  native/           Rust crate (napi-rs): src/lib.rs, src/frame.rs, src/layouts/{whirlpool,raydium_clmm}.rs
  src/
    contract.ts     status codes, out-array slot indexes, FrameDecoder interface (shared by both)
    reference.ts    TypeScript reference implementation
    index.ts        loader: native if available and DECODER allows it, else reference
  fuzz/             cargo-fuzz targets
  fixtures/         recorded frames + expected outputs (shared with parity tests)
```

## Contract

```ts
interface FrameDecoder {
  readonly impl: 'native' | 'reference';
  decodeNotification(frame: Uint8Array, out: Float64Array): number;          // hot path
  decodeAccount(data: Uint8Array, venue: Venue): PoolInfo | DecodeError;     // cold path (boot, revalidation)
}
```

### `decodeNotification` output slots

`out` is a `Float64Array` of length 8, owned by the caller and reused for every call.

| Index | Name | Meaning |
|---|---|---|
| 0 | `SUB` | Subscription id, or −1 if not recoverable |
| 1 | `SLOT` | `params.result.context.slot` (account) or `params.result.slot` (slot notification) |
| 2 | `LAYOUT` | 1 = Whirlpool, 2 = Raydium CLMM |
| 3 | `SQRT` | `sqrt_price / 2^64` as a correctly rounded f64 |
| 4 | `LIQ` | Active liquidity (u128) as a correctly rounded f64 |
| 5 | `TICK` | Current tick index (i32) |
| 6 | `SIZE_UNEXPECTED` | 1 if the account length ≠ the documented size for the layout, else 0 |
| 7 | — | Reserved |

The f64 values are exact for every quantity that matters. Subscription ids and slots are below 2^53. `sqrt_price` divided by a power of two keeps a 53-bit relative precision of about 1e−16. Liquidity is used only for the approximate depth estimate.

### Status codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `ACCOUNT` | Account notification decoded. Slots 0–5 are valid. |
| 2 | `SLOT` | Slot notification. Slots 0–1 are valid. |
| 0 | `OTHER` | Valid JSON that is not a notification (confirmation, error, unknown method). The caller parses it. |
| −1 | `MALFORMED_JSON` | Not valid JSON, or a required field has the wrong type |
| −2 | `BAD_ENCODING` | Data is not `[string, "base64"]`, or invalid base64 |
| −3 | `BAD_LENGTH` | Decoded length is shorter than the layout's minimum (the highest byte offset read), or exceeds the scratch buffer |
| −4 | `UNKNOWN_LAYOUT` | The 8-byte discriminator doesn't match any known layout |
| −5 | `INVALID_VALUE` | Decoded fields fail sanity checks (e.g. `sqrt_price == 0`) |
| −6 | `PANIC` | A Rust panic was caught. This indicates a decoder bug and is fuzz-target territory. |

The decoder writes `SUB` as early as it can. For a frame with a recoverable subscription id but a bad payload (codes −2 to −5), `out[SUB]` is valid, so ingest can mark the right pool as suspect.

## Frame Parsing

A notification has this shape:
```json
{"jsonrpc":"2.0","method":"accountNotification","params":{"result":{"context":{"slot":N},
 "value":{"data":["<base64>","base64"],"executable":false,"lamports":L,"owner":"<pk>","rentEpoch":R,"space":S}},
 "subscription":ID}}
```

Rust parses it with `serde_json` into **borrowed** structs (`&'a str` fields, zero-copy against the input slice). Unknown fields are ignored. Field order is not assumed, since JSON object order is not guaranteed. Only `method`, `params.subscription`, `params.result.context.slot` / `params.result.slot`, and `params.result.value.data` are read. `owner` is not checked per frame, because ownership was validated at boot and accounts can't change owner while subscribed in a way that matters to a read-only feed. The base64 payload is decoded into a 4 KiB stack buffer. A payload larger than that fails with `BAD_LENGTH` before decoding.

## Account Layouts

**Length policy:** an account is accepted if its length is ≥ the layout's **minimum length** (the end of the highest field read) and ≤ the scratch buffer size. A length different from the documented size (653 / 1544) is still decoded, and is flagged by setting `out[6]` (`SIZE_UNEXPECTED`) to `1`. Ingest logs that once per layout at `warn`. Program upgrades that append fields therefore keep working, and the warning makes them visible.

Both are Anchor accounts: the first 8 bytes are the discriminator `sha256("account:<Name>")[..8]`. The constants are computed in a `build.rs` or `const` test from the name, never pasted by hand, and are verified against recorded fixtures. All integers are little-endian.

### Orca Whirlpool (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`, account `Whirlpool`, 653 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | discriminator | [u8; 8] |
| 8 | whirlpools_config | Pubkey |
| 40 | whirlpool_bump | u8 |
| 41 | tick_spacing | u16 |
| 43 | fee_tier_index_seed | [u8; 2] |
| 45 | fee_rate | u16 |
| 47 | protocol_fee_rate | u16 |
| 49 | **liquidity** | u128 |
| 65 | **sqrt_price** (Q64.64) | u128 |
| 81 | **tick_current_index** | i32 |
| 101 | token_mint_a | Pubkey |
| 181 | token_mint_b | Pubkey |

Price of A in B (raw units) is `(sqrt_price / 2^64)^2`. Decimals are not stored, so ingest supplies them.

### Raydium CLMM (`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, account `PoolState`, 1544 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | discriminator | [u8; 8] |
| 8 | bump | u8 |
| 9 | amm_config | Pubkey |
| 41 | owner | Pubkey |
| 73 | token_mint_0 | Pubkey |
| 105 | token_mint_1 | Pubkey |
| 233 | mint_decimals_0 | u8 |
| 234 | mint_decimals_1 | u8 |
| 235 | tick_spacing | u16 |
| 237 | **liquidity** | u128 |
| 253 | **sqrt_price_x64** (Q64.64) | u128 |
| 269 | **tick_current** | i32 |

Price of token0 in token1 (raw units) is `(sqrt_price_x64 / 2^64)^2`.

The offsets above are the design's expectation, taken from the programs' published account structs. **The recorded fixtures are the authority.** A parity test cross-checks the decoded mints and price against each venue's official SDK on the same account bytes. If the fixtures disagree with this table, the table is wrong and gets fixed.

### Sanity checks (`INVALID_VALUE`)

- `sqrt_price` must be greater than 0 and within the program's documented bounds (`MIN_SQRT_PRICE ≤ p ≤ MAX_SQRT_PRICE` for each venue).
- `tick_current` must be within `[MIN_TICK, MAX_TICK]`. `liquidity` may legitimately be 0, which is reported as is.

## Normalization Split

The decoder outputs the **raw, venue-oriented ratio** (`SQRT`). Ingest and the reconciler apply decimals and orientation with the pool context they own:

- `price = SQRT² · 10^(decBase − decQuote)`, inverted when the quote is token A/0.

This is three floating-point operations in JS. Keeping per-pool context (decimals, orientation, the subscription mapping that changes on reconnect) out of Rust keeps the decoder stateless. A stateful native registry would need synchronizing on every reconnect, and the CPU it would save is negligible.

## Cold Path: `decodeAccount`

`decodeAccount` takes the raw account bytes from an RPC response (already base64-decoded by the caller, since this path isn't hot) and returns a full `PoolInfo`: mints as base58 strings, decimals where the layout has them, sqrt ratio, liquidity, tick, and layout. It is used for boot validation and revalidation. It is allowed to allocate.

## napi Boundary

- `#[napi]` functions take `frame: &[u8]` (via `Buffer` / `Uint8Array`, borrowed without copying) and `out: &mut [f64]` (`Float64Array`, also borrowed).
- The whole body runs in `std::panic::catch_unwind`, and a panic becomes code −6. The crate builds with `panic = "unwind"` (required for this) and never uses `unsafe` outside napi-generated glue.
- Prebuilt targets are `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, and `aarch64-apple-darwin`. Docker builds for the image platform (see `delivery.md`).
- The loader (`index.ts`) catches `require` failures under `DECODER=auto`, logs the reason, and returns the reference decoder.

## TypeScript Reference Decoder

The reference decoder has the same function signatures and output semantics. To match Rust bit for bit:

- **u128 → f64:** combine as `BigInt` and convert with `Number(big)`. Both `Number(bigint)` and Rust's `u128 as f64` round to nearest, ties to even, so results are identical. Splitting into `hi·2^64 + lo` doubles would round twice and break parity.
- **`/ 2^64`:** multiplication by the exact constant `2^-64`, which is exact in both languages.
- **JSON:** `JSON.parse(frame.toString('utf8'))`, then the same field extraction, with the same status code for each failure class.
- **base64:** `Buffer.from(s, 'base64')`, with explicit validation, because Node's decoder is lenient and silently skips invalid characters. The reference must reject anything Rust rejects.

Parity is defined on the **status code plus output slots 0–6** for every fixture and every fuzz-corpus input. Divergence on any input fails the test.

## Testing

- **Fixtures:** recorded mainnet frames for both layouts (via `pnpm record`, see `replay-and-benchmark.md`), each with an expected decoded output checked against the official venue SDK once at record time.
- **Rust:** unit tests per layout, `proptest` for valid layouts with random field values, and `cargo-fuzz` targets for `decode_notification` and `decode_account`. CI runs each fuzz target for a time-boxed run.
- **Parity:** Vitest runs both implementations over fixtures, the fuzz corpus, and a fast-check generator of mutated frames, asserting identical results.
- **Malformed input:** truncated frames, flipped bytes, wrong discriminator, oversized base64, nested garbage, non-UTF-8 bytes. Every case must return a status code. None may panic or throw.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Hot-path input | Whole raw frame | Pre-parsed account bytes | HLD KDD-2. Parsing plus base64 is the real CPU and allocation cost. |
| Output | Caller-owned `Float64Array` + int status | Return a JS object; return a typed struct via napi | Creating a JS object per frame is exactly the GC churn the addon exists to avoid. Reading a typed array costs only memory access. |
| JSON parser | `serde_json` with borrowed structs | `simd-json`; a hand-written scanner | Borrowed serde avoids per-field allocation and is robust to field order. `simd-json` needs a mutable buffer and is a candidate for the optimization loop if profiling shows it would help. A hand-written scanner is fragile against legal JSON variation. |
| Normalization location | Raw ratio in Rust, decimals and orientation in JS | Full price in Rust with a native pool registry | Keeps Rust stateless (no reconnect synchronization) for a three-flop cost. |
| Discriminators | Derived from `sha256("account:<Name>")` | Hard-coded byte literals | No magic numbers copied by hand, and verified by fixtures. |
| Panic strategy | `catch_unwind` → status −6 | `panic = abort` | An abort would kill the process (HLD Goal 4). Unwinding through `catch_unwind` at the FFI boundary is the sound way to contain a panic. |
| Reference decoder | Full TS twin with exact parity | Rust only | Provides differential testing, a benchmark baseline that justifies Rust (HLD success metric), and a portable fallback. |
| u128 conversion in TS | `Number(BigInt)` | Two doubles combined | Correct rounding is required for exact parity. |

## Open Questions & Future Decisions

### Resolved
1. ✅ Mints and owner are not checked per frame. They are validated at boot and on revalidation.
2. ✅ Parity is on status code plus slots 0–6, exact equality.
3. ✅ Length is checked against a minimum, not an exact size. An unexpected size is flagged, not rejected.

### Deferred
1. A sliced-layout variant if `dataSlice` turns out to be supported on subscriptions (see `ingest-sources.md`).
2. `simd-json` or a SIMD base64 decoder, adopted only if the optimization loop shows the decoder on the p99 critical path.
3. Phoenix market layout (stretch goal): order-book decode adds a third layout and a depth output contract.

## References

- Orca Whirlpools program source: `programs/whirlpool/src/state/whirlpool.rs`
- Raydium CLMM program source: `programs/amm/src/states/pool.rs`
- napi-rs: https://napi.rs
- Anchor account discriminator convention
