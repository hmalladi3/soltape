mod common;
use common::*;
use sha2::{Digest, Sha256};
use soltape_decoder_core::*;

fn disc(name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("account:{name}").as_bytes());
    h[..8].try_into().unwrap()
}

// @spec DEC-LAY-001
#[test]
fn discriminators_match_derived_values_and_fixtures() {
    for f in fixtures() {
        let r = raw(&f);
        let expected = if f.owner.starts_with("whirL") {
            disc("Whirlpool")
        } else {
            disc("PoolState")
        };
        assert_eq!(&r[..8], &expected, "{}", f.address);
        let venue = if f.owner.starts_with("whirL") {
            Venue::Orca
        } else {
            Venue::Raydium
        };
        assert!(decode_account(&r, venue).is_ok(), "{}", f.address);
    }
}

// @spec DEC-LAY-002, DEC-LAY-003, DEC-LAY-004
#[test]
fn notification_fields_match_documented_offsets() {
    for f in fixtures() {
        let r = raw(&f);
        let (liq_off, sqrt_off, tick_off, layout) = if f.owner.starts_with("whirL") {
            (49, 65, 81, LAYOUT_WHIRLPOOL)
        } else {
            (237, 253, 269, LAYOUT_RAYDIUM_CLMM)
        };
        let mut out = [f64::NAN; OUT_LEN];
        assert_eq!(
            decode_notification(&account_frame(&f.data_b64, 5, 6), &mut out),
            ACCOUNT,
            "{}",
            f.address
        );
        assert_eq!(out[OUT_LAYOUT], f64::from(layout));
        assert_eq!(out[OUT_SQRT], u128_le(&r, sqrt_off) as f64 * 2f64.powi(-64));
        assert_eq!(out[OUT_LIQ], u128_le(&r, liq_off) as f64);
        assert_eq!(
            out[OUT_TICK],
            f64::from(i32::from_le_bytes(
                r[tick_off..tick_off + 4].try_into().unwrap()
            ))
        );
    }
}
