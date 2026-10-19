#![allow(dead_code)]
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub struct Fixture {
    pub address: String,
    pub owner: String,
    pub data_b64: String,
}

pub fn fixtures() -> Vec<Fixture> {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/accounts.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["pools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| Fixture {
            address: p["address"].as_str().unwrap().to_owned(),
            owner: p["owner"].as_str().unwrap().to_owned(),
            data_b64: p["data"].as_str().unwrap().to_owned(),
        })
        .collect()
}

pub fn raw(f: &Fixture) -> Vec<u8> {
    STANDARD.decode(&f.data_b64).unwrap()
}

pub fn account_frame(data_b64: &str, sub: u64, slot: u64) -> Vec<u8> {
    format!(
        r#"{{"jsonrpc":"2.0","method":"accountNotification","params":{{"result":{{"context":{{"slot":{slot}}},"value":{{"data":["{data_b64}","base64"],"executable":false,"lamports":1,"owner":"x","rentEpoch":18446744073709551615,"space":653}}}},"subscription":{sub}}}}}"#
    )
    .into_bytes()
}

pub fn u128_le(b: &[u8], off: usize) -> u128 {
    u128::from_le_bytes(b[off..off + 16].try_into().unwrap())
}
