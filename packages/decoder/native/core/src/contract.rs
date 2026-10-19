//! Status codes and output-slot indexes shared with the TypeScript contract
//! (`packages/decoder/src/contract.ts`). Values are part of the FFI contract.

pub const ACCOUNT: i32 = 1;
pub const SLOT: i32 = 2;
pub const OTHER: i32 = 0;
pub const MALFORMED_JSON: i32 = -1;
pub const BAD_ENCODING: i32 = -2;
pub const BAD_LENGTH: i32 = -3;
pub const UNKNOWN_LAYOUT: i32 = -4;
pub const INVALID_VALUE: i32 = -5;
pub const PANIC: i32 = -6;

pub const OUT_SUB: usize = 0;
pub const OUT_SLOT: usize = 1;
pub const OUT_LAYOUT: usize = 2;
pub const OUT_SQRT: usize = 3;
pub const OUT_LIQ: usize = 4;
pub const OUT_TICK: usize = 5;
pub const OUT_SIZE_UNEXPECTED: usize = 6;
pub const OUT_LEN: usize = 8;

pub const LAYOUT_WHIRLPOOL: u8 = 1;
pub const LAYOUT_RAYDIUM_CLMM: u8 = 2;

/// Largest decoded account accepted (stack scratch buffer size).
pub const MAX_ACCOUNT_LEN: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Venue {
    Orca,
    Raydium,
}
