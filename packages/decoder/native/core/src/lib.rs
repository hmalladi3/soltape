//! Pure decoder for Solana JSON-RPC account notifications carrying Orca Whirlpool
//! and Raydium CLMM pool accounts. No I/O, no global state, no allocation on the
//! notification path. See docs/llds/frame-decoder.md.
#![forbid(unsafe_code)]

pub mod contract;
pub mod frame;
pub mod layouts;

pub use contract::*;
pub use frame::decode_notification;
pub use layouts::{PoolInfo, decode_account};

/// Runs a decoder call, converting a panic into the `PANIC` status (FFI boundary guard).
pub fn guarded<F: FnOnce() -> i32>(f: F) -> i32 {
    f() // Phase 5 stub: does not yet catch panics
}
