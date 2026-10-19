//! napi-rs boundary. Every call is wrapped in `catch_unwind`; panics become `PANIC`.
use napi::bindgen_prelude::Float64Array;
use napi_derive::napi;
use soltape_decoder_core as core;
use std::panic::{AssertUnwindSafe, catch_unwind};

#[napi]
pub fn decode_notification(frame: &[u8], mut out: Float64Array) -> i32 {
    // SAFETY: the typed array is owned by the JS caller and is neither detached nor
    // aliased for the duration of this synchronous call (JS is single-threaded here).
    let out: &mut [f64] = unsafe { out.as_mut() };
    if out.len() < core::OUT_LEN {
        return core::INVALID_VALUE;
    }
    core::guarded(|| core::decode_notification(frame, out))
}

#[napi(object)]
pub struct PoolInfoJs {
    pub layout: u32,
    pub mint_a: String,
    pub mint_b: String,
    pub decimals_a: Option<u32>,
    pub decimals_b: Option<u32>,
    pub sqrt_ratio: f64,
    pub liquidity: f64,
    pub tick: i32,
    pub size_unexpected: bool,
}

#[napi(object)]
pub struct DecodeAccountResult {
    pub status: i32,
    pub info: Option<PoolInfoJs>,
}

#[napi]
pub fn decode_account(data: &[u8], venue: String) -> DecodeAccountResult {
    let venue = match venue.as_str() {
        "orca" => core::Venue::Orca,
        "raydium" => core::Venue::Raydium,
        _ => return DecodeAccountResult { status: core::UNKNOWN_LAYOUT, info: None },
    };
    match catch_unwind(AssertUnwindSafe(|| core::decode_account(data, venue))) {
        Ok(Ok(p)) => DecodeAccountResult {
            status: core::ACCOUNT,
            info: Some(PoolInfoJs {
                layout: u32::from(p.layout),
                mint_a: bs58::encode(p.mint_a).into_string(),
                mint_b: bs58::encode(p.mint_b).into_string(),
                decimals_a: p.decimals.map(|d| u32::from(d.0)),
                decimals_b: p.decimals.map(|d| u32::from(d.1)),
                sqrt_ratio: p.sqrt_ratio,
                liquidity: p.liquidity,
                tick: p.tick,
                size_unexpected: p.size_unexpected,
            }),
        },
        Ok(Err(code)) => DecodeAccountResult { status: code, info: None },
        Err(_) => DecodeAccountResult { status: core::PANIC, info: None },
    }
}
