//! DEC-NAT-002: the notification path performs no heap allocation.
mod common;
use common::*;
use soltape_decoder_core::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static TRACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

// @spec DEC-NAT-002
#[test]
fn decode_notification_does_not_allocate() {
    let frames: Vec<Vec<u8>> = fixtures()
        .iter()
        .map(|f| account_frame(&f.data_b64, 1, 2))
        .collect();
    let slot = br#"{"jsonrpc":"2.0","method":"slotNotification","params":{"result":{"parent":1,"root":0,"slot":2},"subscription":3}}"#.to_vec();
    let mut out = [0f64; OUT_LEN];
    TRACK.store(true, Ordering::SeqCst);
    let mut ok = true;
    for f in frames.iter().chain(std::iter::once(&slot)) {
        let s = decode_notification(f, &mut out);
        ok &= s == ACCOUNT || s == SLOT;
    }
    TRACK.store(false, Ordering::SeqCst);
    assert!(ok, "every frame must decode");
    assert_eq!(
        ALLOCS.load(Ordering::SeqCst),
        0,
        "heap allocations on the notification path"
    );
}
