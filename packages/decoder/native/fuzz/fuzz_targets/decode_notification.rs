//! Any byte sequence must yield a status code in range without panicking (DEC-FRAME-012).
#![no_main]
use libfuzzer_sys::fuzz_target;
use soltape_decoder_core::{OUT_LEN, decode_notification};

fuzz_target!(|data: &[u8]| {
    let mut out = [0f64; OUT_LEN];
    let status = decode_notification(data, &mut out);
    assert!((-5..=2).contains(&status), "status {status} out of range");
});
