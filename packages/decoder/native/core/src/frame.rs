use crate::contract::*;

/// Decodes one raw WebSocket notification frame into `out`. Returns a status code.
pub fn decode_notification(_frame: &[u8], out: &mut [f64]) -> i32 {
    out[OUT_SUB] = -1.0;
    OTHER // Phase 5 stub
}
