# Frame Decoder — EARS Specs

LLD: `docs/llds/frame-decoder.md`

These specs apply to **both** decoder implementations (native napi-rs and TypeScript reference) unless a spec names one.

## Notification Decoding (`decodeNotification`)

- [ ] **DEC-FRAME-001**: When given an `accountNotification` frame whose account data decodes as a known layout, both decoder implementations shall return `ACCOUNT` (1) and write subscription id, slot, layout, sqrt ratio, liquidity, current tick, and the size-unexpected flag into output slots 0–6.
- [ ] **DEC-FRAME-002**: When given a `slotNotification` frame, both decoder implementations shall return `SLOT` (2) and write the subscription id and slot into output slots 0–1.
- [ ] **DEC-FRAME-003**: When given valid JSON that is neither an account nor a slot notification, both decoder implementations shall return `OTHER` (0).
- [ ] **DEC-FRAME-004**: If the frame is not valid JSON or a required notification field has the wrong type, then both decoder implementations shall return `MALFORMED_JSON` (−1).
- [ ] **DEC-FRAME-005**: If the account `data` field is not a `[string, "base64"]` pair or contains invalid base64, then both decoder implementations shall return `BAD_ENCODING` (−2).
- [ ] **DEC-FRAME-006**: If the decoded account is shorter than the matched layout's minimum length or longer than 4 KiB, then both decoder implementations shall return `BAD_LENGTH` (−3).
- [ ] **DEC-FRAME-007**: If the decoded account's first 8 bytes match no known layout discriminator, then both decoder implementations shall return `UNKNOWN_LAYOUT` (−4).
- [ ] **DEC-FRAME-008**: If a decoded sqrt price lies outside the venue's valid range (`MIN_SQRT_PRICE`..`MAX_SQRT_PRICE`) or the current tick lies outside `MIN_TICK`..`MAX_TICK`, then both decoder implementations shall return `INVALID_VALUE` (−5).
- [ ] **DEC-FRAME-009**: When a frame's subscription id is recoverable but its payload fails with codes −2 through −5, both decoder implementations shall write the subscription id into output slot 0. Otherwise they shall write −1 there.
- [ ] **DEC-FRAME-010**: Both decoder implementations shall read notification fields independently of JSON object key order, and shall ignore unknown fields.
- [ ] **DEC-FRAME-011**: When a decoded account's length differs from the layout's documented size (Whirlpool 653 bytes, Raydium CLMM `PoolState` 1544 bytes) but meets its minimum length, both decoder implementations shall decode it and set output slot 6 to 1.
- [ ] **DEC-FRAME-012**: Both decoder implementations shall return a status code for every possible input byte sequence, and shall never throw an exception to the caller.

## Native Implementation

- [ ] **DEC-NAT-001**: The native decoder shall borrow the frame bytes and the output `Float64Array` without copying, and shall return only an integer status.
- [ ] **DEC-NAT-002**: The native decoder's `decodeNotification` shall perform no heap allocation.
- [ ] **DEC-NAT-003**: If a Rust panic occurs inside a native decoder call, then the native decoder shall catch it at the FFI boundary and return `PANIC` (−6).
- [ ] **DEC-NAT-004**: The native decoder shall perform no I/O and hold no mutable state between calls.

## Layouts

- [ ] **DEC-LAY-001**: Both decoder implementations shall identify Anchor account layouts by discriminators derived as the first 8 bytes of `sha256("account:<Name>")`, for `Whirlpool` and `PoolState`.
- [ ] **DEC-LAY-002**: When decoding a Whirlpool account, both decoder implementations shall read liquidity (u128 at offset 49), sqrt price (Q64.64 u128 at offset 65), and current tick (i32 at offset 81) as little-endian values.
- [ ] **DEC-LAY-003**: When decoding a Raydium CLMM `PoolState` account, both decoder implementations shall read liquidity (u128 at offset 237), sqrt price (Q64.64 u128 at offset 253), and current tick (i32 at offset 269) as little-endian values.
- [ ] **DEC-LAY-004**: Both decoder implementations shall output sqrt ratio as the correctly rounded f64 of the u128 sqrt price multiplied by exactly 2^−64, and liquidity as the correctly rounded f64 of the u128 liquidity.
- [ ] **DEC-LAY-005**: When `decodeAccount` is called with account bytes and a venue, both decoder implementations shall return the full pool info: base58 mints, stored decimals where the layout has them, sqrt ratio, liquidity, tick, and layout. Otherwise they shall return a typed decode error.

## Reference Implementation and Parity

- [ ] **DEC-REF-001**: The TypeScript reference decoder shall convert u128 values via `Number(BigInt)` so that its rounding matches the native decoder exactly.
- [ ] **DEC-REF-002**: The TypeScript reference decoder shall reject every base64 input that the native decoder rejects, despite Node's lenient base64 decoding.
- [ ] **DEC-PAR-001**: For every recorded fixture frame, fuzz-corpus input, and generated mutated frame, the native and reference decoders shall return the same status code and bit-identical output slots 0–6.

## Deferred

- [D] **DEC-LAY-010**: When decoding a Phoenix market account, the decoder shall output top-of-book bid and ask prices and sizes.
