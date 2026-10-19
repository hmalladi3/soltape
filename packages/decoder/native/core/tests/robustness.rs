mod common;
use common::*;
use proptest::prelude::*;
use soltape_decoder_core::*;

// @spec DEC-NAT-003
#[test]
fn guarded_converts_panics_to_panic_status() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let s = guarded(|| panic!("boom"));
    std::panic::set_hook(prev);
    assert_eq!(s, PANIC);
    assert_eq!(guarded(|| ACCOUNT), ACCOUNT);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(5000))]

    // @spec DEC-FRAME-012
    #[test]
    fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..2048)) {
        let mut out = [0f64; OUT_LEN];
        let s = decode_notification(&bytes, &mut out);
        prop_assert!((-5..=2).contains(&s));
    }

    // @spec DEC-FRAME-012
    #[test]
    fn mutated_fixture_frames_never_panic(idx in 0usize..10, flips in proptest::collection::vec((any::<usize>(), any::<u8>()), 1..6), cut in any::<usize>()) {
        let fx = fixtures();
        let f = &fx[idx % fx.len()];
        let mut frame = account_frame(&f.data_b64, 1, 2);
        for (at, b) in flips { let n = frame.len(); frame[at % n] = b; }
        let n = frame.len();
        frame.truncate(cut % (n + 1));
        let mut out = [0f64; OUT_LEN];
        let s = decode_notification(&frame, &mut out);
        prop_assert!((-5..=2).contains(&s));
    }

    // @spec DEC-FRAME-012
    #[test]
    fn decode_account_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..2048), orca in any::<bool>()) {
        let _ = decode_account(&bytes, if orca { Venue::Orca } else { Venue::Raydium });
    }
}
