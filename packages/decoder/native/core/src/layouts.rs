use crate::contract::*;

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

/// Decodes a full pool account (cold path). Returns a negative status code on failure.
pub fn decode_account(_data: &[u8], _venue: Venue) -> Result<PoolInfo, i32> {
    Err(UNKNOWN_LAYOUT) // Phase 5 stub
}
