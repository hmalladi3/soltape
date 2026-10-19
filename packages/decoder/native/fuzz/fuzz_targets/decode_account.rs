//! Any account bytes, for either venue, must decode or fail with a status code (DEC-FRAME-012).
#![no_main]
use libfuzzer_sys::fuzz_target;
use soltape_decoder_core::{Venue, decode_account};

fuzz_target!(|data: &[u8]| {
    let venue = if data.first().is_some_and(|b| b & 1 == 0) { Venue::Orca } else { Venue::Raydium };
    if let Err(code) = decode_account(data.get(1..).unwrap_or(&[]), venue) {
        assert!((-5..=-1).contains(&code), "error code {code} out of range");
    }
});
