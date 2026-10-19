//! Account layouts for Orca Whirlpool and Raydium CLMM `PoolState` (little-endian, Anchor).
use crate::contract::*;

include!(concat!(env!("OUT_DIR"), "/discriminators.rs"));

pub const WHIRLPOOL_SIZE: usize = 653;
pub const RAYDIUM_POOL_STATE_SIZE: usize = 1544;
/// End of the highest field read from each layout (mints included).
pub const WHIRLPOOL_MIN_LEN: usize = 213;
pub const RAYDIUM_MIN_LEN: usize = 273;

const MIN_TICK: i32 = -443_636;
const MAX_TICK: i32 = 443_636;
const WHIRLPOOL_MIN_SQRT: u128 = 4_295_048_016;
const WHIRLPOOL_MAX_SQRT: u128 = 79_226_673_515_401_279_992_447_579_055;
const RAYDIUM_MIN_SQRT: u128 = 4_295_048_016;
const RAYDIUM_MAX_SQRT: u128 = 79_226_673_521_066_979_257_578_248_091;

/// 2^-64, exact in f64.
const TWO_POW_NEG_64: f64 = 1.0 / 18_446_744_073_709_551_616.0;

struct Spec {
    layout: u8,
    size: usize,
    min_len: usize,
    liquidity: usize,
    sqrt_price: usize,
    tick: usize,
    mint_a: usize,
    mint_b: usize,
    decimals: Option<(usize, usize)>,
    min_sqrt: u128,
    max_sqrt: u128,
}

const WHIRLPOOL: Spec = Spec {
    layout: LAYOUT_WHIRLPOOL,
    size: WHIRLPOOL_SIZE,
    min_len: WHIRLPOOL_MIN_LEN,
    liquidity: 49,
    sqrt_price: 65,
    tick: 81,
    mint_a: 101,
    mint_b: 181,
    decimals: None,
    min_sqrt: WHIRLPOOL_MIN_SQRT,
    max_sqrt: WHIRLPOOL_MAX_SQRT,
};

const RAYDIUM: Spec = Spec {
    layout: LAYOUT_RAYDIUM_CLMM,
    size: RAYDIUM_POOL_STATE_SIZE,
    min_len: RAYDIUM_MIN_LEN,
    liquidity: 237,
    sqrt_price: 253,
    tick: 269,
    mint_a: 73,
    mint_b: 105,
    decimals: Some((233, 234)),
    min_sqrt: RAYDIUM_MIN_SQRT,
    max_sqrt: RAYDIUM_MAX_SQRT,
};

/// The price-bearing fields read on the hot path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PriceFields {
    pub layout: u8,
    pub sqrt_ratio: f64,
    pub liquidity: f64,
    pub tick: i32,
    pub size_unexpected: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PoolInfo {
    pub layout: u8,
    pub mint_a: [u8; 32],
    pub mint_b: [u8; 32],
    pub decimals: Option<(u8, u8)>,
    pub sqrt_ratio: f64,
    pub liquidity: f64,
    pub tick: i32,
    pub size_unexpected: bool,
}

fn spec_for(data: &[u8]) -> Result<&'static Spec, i32> {
    if data.len() < 8 {
        return Err(BAD_LENGTH);
    }
    let disc = &data[..8];
    let spec = if disc == WHIRLPOOL_DISCRIMINATOR {
        &WHIRLPOOL
    } else if disc == RAYDIUM_POOL_STATE_DISCRIMINATOR {
        &RAYDIUM
    } else {
        return Err(UNKNOWN_LAYOUT);
    };
    if data.len() < spec.min_len {
        return Err(BAD_LENGTH);
    }
    Ok(spec)
}

fn u128_at(d: &[u8], off: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[off..off + 16]);
    u128::from_le_bytes(b)
}

fn i32_at(d: &[u8], off: usize) -> i32 {
    let mut b = [0u8; 4];
    b.copy_from_slice(&d[off..off + 4]);
    i32::from_le_bytes(b)
}

fn read_price(spec: &Spec, data: &[u8]) -> Result<PriceFields, i32> {
    let sqrt = u128_at(data, spec.sqrt_price);
    let tick = i32_at(data, spec.tick);
    if sqrt < spec.min_sqrt || sqrt > spec.max_sqrt || !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return Err(INVALID_VALUE);
    }
    Ok(PriceFields {
        layout: spec.layout,
        // `as f64` rounds to nearest, ties to even; scaling by 2^-64 is exact.
        sqrt_ratio: sqrt as f64 * TWO_POW_NEG_64,
        liquidity: u128_at(data, spec.liquidity) as f64,
        tick,
        size_unexpected: data.len() != spec.size,
    })
}

/// Hot path: identifies the layout by discriminator and reads the price-bearing fields.
// @spec DEC-LAY-001, DEC-LAY-002, DEC-LAY-003, DEC-LAY-004, DEC-FRAME-007, DEC-FRAME-008, DEC-FRAME-011
pub fn decode_price_fields(data: &[u8]) -> Result<PriceFields, i32> {
    let spec = spec_for(data)?;
    read_price(spec, data)
}

/// Cold path: decodes the full pool info, requiring the layout to belong to `venue`.
// @spec DEC-LAY-005
pub fn decode_account(data: &[u8], venue: Venue) -> Result<PoolInfo, i32> {
    let spec = spec_for(data)?;
    let expected = match venue {
        Venue::Orca => LAYOUT_WHIRLPOOL,
        Venue::Raydium => LAYOUT_RAYDIUM_CLMM,
    };
    if spec.layout != expected {
        return Err(UNKNOWN_LAYOUT);
    }
    let p = read_price(spec, data)?;
    let mut mint_a = [0u8; 32];
    let mut mint_b = [0u8; 32];
    mint_a.copy_from_slice(&data[spec.mint_a..spec.mint_a + 32]);
    mint_b.copy_from_slice(&data[spec.mint_b..spec.mint_b + 32]);
    Ok(PoolInfo {
        layout: spec.layout,
        mint_a,
        mint_b,
        decimals: spec.decimals.map(|(a, b)| (data[a], data[b])),
        sqrt_ratio: p.sqrt_ratio,
        liquidity: p.liquidity,
        tick: p.tick,
        size_unexpected: p.size_unexpected,
    })
}
