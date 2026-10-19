//! Derives Anchor account discriminators (`sha256("account:<Name>")[..8]`) at build time
//! so no magic bytes are pasted by hand (docs/llds/frame-decoder.md § Account Layouts).
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

fn main() {
    let mut out = String::new();
    for (konst, name) in [
        ("WHIRLPOOL_DISCRIMINATOR", "Whirlpool"),
        ("RAYDIUM_POOL_STATE_DISCRIMINATOR", "PoolState"),
    ] {
        let h = Sha256::digest(format!("account:{name}").as_bytes());
        out.push_str(&format!("pub const {konst}: [u8; 8] = {:?};\n", &h[..8]));
    }
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("discriminators.rs"),
        out,
    )
    .unwrap();
    println!("cargo::rerun-if-changed=build.rs");
}
