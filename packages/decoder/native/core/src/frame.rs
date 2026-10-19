//! Notification frame parsing: one pass, zero-copy, allocation-free on well-formed frames.
//!
//! Semantics mirror `JSON.parse` so the TypeScript reference decoder can match bit for bit:
//! - duplicate keys resolve last-wins, key order is irrelevant, unknown fields are ignored;
//! - every known field is read *tolerantly* (a wrong JSON type is recorded, not an error),
//!   so the method can be decided after the whole frame is read, whatever the key order;
//! - leaf values are captured as raw JSON text and interpreted here: a string serde cannot
//!   represent (lone surrogate escape) is "a string that matches nothing", and a number that
//!   overflows f64 is "not a valid id" — exactly how JS sees them.
//!
//! The only inputs where serde itself rejects what `JSON.parse` accepts are keys, or scalar
//! values at container positions, that serde cannot represent. The reference decoder mirrors
//! that rule (see `strictRejects` in src/reference.ts).
use crate::contract::*;
use crate::layouts::decode_price_fields;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::fmt;
use std::marker::PhantomData;

/// Longest base64 text whose decoding can fit `MAX_ACCOUNT_LEN` (+2 bytes of slack).
const MAX_B64_LEN: usize = 5464;
const SCRATCH_LEN: usize = MAX_B64_LEN / 4 * 3;
/// 2^53 - 1: largest integer exactly representable in f64 (and JS).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Decodes one raw WebSocket notification frame into `out`. Returns a status code.
/// `out` must have at least `OUT_LEN` slots.
// @spec DEC-FRAME-001, DEC-FRAME-002, DEC-FRAME-003, DEC-FRAME-004, DEC-FRAME-005, DEC-FRAME-006
// @spec DEC-FRAME-009, DEC-FRAME-010, DEC-FRAME-012, DEC-NAT-002
pub fn decode_notification(frame: &[u8], out: &mut [f64]) -> i32 {
    out[OUT_SUB] = -1.0;
    let Ok(text) = std::str::from_utf8(frame) else {
        return MALFORMED_JSON;
    };
    let mut de = serde_json::Deserializer::from_str(text);
    let top = match de.deserialize_any(Tolerant::<TopV>::new()) {
        Ok(t) => t,
        Err(_) => return MALFORMED_JSON,
    };
    if de.end().is_err() {
        return MALFORMED_JSON;
    }
    let Field::Ok(top) = top else { return OTHER };
    let method = match &top.method {
        Field::Ok(raw) => raw_str(raw),
        _ => return OTHER,
    };
    match method.as_deref() {
        Some("accountNotification") => account(&top, out),
        Some("slotNotification") => slot(&top, out),
        _ => OTHER,
    }
}

fn account(top: &Top<'_>, out: &mut [f64]) -> i32 {
    let Field::Ok(p) = &top.params else {
        return MALFORMED_JSON;
    };
    let Field::Ok(r) = &p.result else {
        return MALFORMED_JSON;
    };
    let Field::Ok(c) = &r.context else {
        return MALFORMED_JSON;
    };
    let Field::Ok(v) = &r.value else {
        return MALFORMED_JSON;
    };
    let (Some(sub), Some(slot)) = (id(&p.subscription), id(&c.slot)) else {
        return MALFORMED_JSON;
    };
    if matches!(v.data, Field::Missing) {
        return MALFORMED_JSON;
    }
    out[OUT_SUB] = sub;
    let Some(b64) = base64_text(&v.data) else {
        return BAD_ENCODING;
    };
    if b64.len() > MAX_B64_LEN {
        return BAD_LENGTH;
    }
    let mut scratch = [0u8; SCRATCH_LEN];
    let n = match STANDARD.decode_slice(b64.as_bytes(), &mut scratch) {
        Ok(n) => n,
        Err(_) => return BAD_ENCODING,
    };
    if n > MAX_ACCOUNT_LEN {
        return BAD_LENGTH;
    }
    match decode_price_fields(&scratch[..n]) {
        Ok(f) => {
            out[OUT_SLOT] = slot;
            out[OUT_LAYOUT] = f64::from(f.layout);
            out[OUT_SQRT] = f.sqrt_ratio;
            out[OUT_LIQ] = f.liquidity;
            out[OUT_TICK] = f64::from(f.tick);
            out[OUT_SIZE_UNEXPECTED] = if f.size_unexpected { 1.0 } else { 0.0 };
            ACCOUNT
        }
        Err(code) => code,
    }
}

fn slot(top: &Top<'_>, out: &mut [f64]) -> i32 {
    let Field::Ok(p) = &top.params else {
        return MALFORMED_JSON;
    };
    let Field::Ok(r) = &p.result else {
        return MALFORMED_JSON;
    };
    let (Some(sub), Some(slot)) = (id(&p.subscription), id(&r.slot)) else {
        return MALFORMED_JSON;
    };
    out[OUT_SUB] = sub;
    out[OUT_SLOT] = slot;
    SLOT
}

/// The base64 text when `data` is exactly `[<string>, "base64"]`.
fn base64_text<'a>(data: &Field<Pair<'a>>) -> Option<Cow<'a, str>> {
    let Field::Ok(Pair {
        items: [Some(a), Some(b)],
        extra: false,
    }) = data
    else {
        return None;
    };
    if raw_str(b)?.as_ref() != "base64" {
        return None;
    }
    raw_str(a)
}

/// A subscription id or slot: a JSON number that is a non-negative integer ≤ 2^53 - 1.
/// `-0` is normalized to `0` so both decoders write the same bits.
fn id(f: &Field<&RawValue>) -> Option<f64> {
    let Field::Ok(raw) = f else { return None };
    let t = raw.get();
    if !(t.starts_with('-') || t.as_bytes()[0].is_ascii_digit()) {
        return None;
    }
    // Overflow (e.g. 1e400) is an error here; JS parses it as Infinity, which is equally invalid.
    let v: f64 = serde_json::from_str(t).ok()?;
    (v.is_finite() && v.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&v)).then_some(v + 0.0)
}

/// Reads a JSON string from raw text. Strings serde cannot represent (lone surrogate
/// escapes) yield `None`: a string that matches nothing, as in JS.
fn raw_str(raw: &RawValue) -> Option<Cow<'_, str>> {
    let t = raw.get();
    if !t.starts_with('"') {
        return None;
    }
    if !t.contains('\\') {
        return Some(Cow::Borrowed(&t[1..t.len() - 1]));
    }
    serde_json::from_str::<String>(t).ok().map(Cow::Owned)
}

// ---------------------------------------------------------------------------------------
// Tolerant fields

/// A known field: absent, present with an unexpected JSON type, or present and well-typed.
enum Field<T> {
    Missing,
    Bad,
    Ok(T),
}

// Manual impl: `derive(Default)` would add a `T: Default` bound, which `&RawValue` lacks.
#[allow(clippy::derivable_impls)]
impl<T> Default for Field<T> {
    fn default() -> Self {
        Field::Missing
    }
}

/// Object shapes read by `Tolerant`: which keys they know and how to read each.
trait Shape<'de>: Default {
    const KEYS: &'static [&'static str];
    fn read<M: MapAccess<'de>>(&mut self, key: usize, m: &mut M) -> Result<(), M::Error>;
}

/// Reads an object of shape `S`, or records `Bad` for any other JSON type (consuming it).
struct Tolerant<S>(PhantomData<S>);

impl<S> Tolerant<S> {
    fn new() -> Self {
        Tolerant(PhantomData)
    }
}

impl<'de, S: Shape<'de>> DeserializeSeed<'de> for Tolerant<S> {
    type Value = Field<S>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de, S: Shape<'de>> Visitor<'de> for Tolerant<S> {
    type Value = Field<S>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Self::Value, M::Error> {
        let mut s = S::default();
        while let Some(k) = m.next_key_seed(KeyIs(S::KEYS))? {
            match k {
                Some(i) => s.read(i, &mut m)?,
                None => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(Field::Ok(s))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Self::Value, A::Error> {
        while s.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Field::Bad)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
}

/// Matches a field name against known keys without allocating.
struct KeyIs(&'static [&'static str]);

impl<'de> DeserializeSeed<'de> for KeyIs {
    type Value = Option<usize>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_str(self)
    }
}

impl Visitor<'_> for KeyIs {
    type Value = Option<usize>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a field name")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(self.0.iter().position(|k| *k == v))
    }
}

/// A leaf captured as raw JSON text (interpreted later by `id` / `raw_str`).
fn leaf<'de, M: MapAccess<'de>>(m: &mut M) -> Result<Field<&'de RawValue>, M::Error> {
    Ok(Field::Ok(m.next_value::<&'de RawValue>()?))
}

// ---------------------------------------------------------------------------------------
// Frame shapes. Account and slot notifications share `params` and `result`, so the shapes
// hold the union of both; the method decides which fields matter.

#[derive(Default)]
struct Top<'a> {
    method: Field<&'a RawValue>,
    params: Field<Params<'a>>,
}
type TopV<'a> = Top<'a>;

impl<'de> Shape<'de> for Top<'de> {
    const KEYS: &'static [&'static str] = &["method", "params"];
    fn read<M: MapAccess<'de>>(&mut self, key: usize, m: &mut M) -> Result<(), M::Error> {
        match key {
            0 => self.method = leaf(m)?,
            _ => self.params = m.next_value_seed(Tolerant::new())?,
        }
        Ok(())
    }
}

#[derive(Default)]
struct Params<'a> {
    subscription: Field<&'a RawValue>,
    result: Field<Res<'a>>,
}

impl<'de> Shape<'de> for Params<'de> {
    const KEYS: &'static [&'static str] = &["subscription", "result"];
    fn read<M: MapAccess<'de>>(&mut self, key: usize, m: &mut M) -> Result<(), M::Error> {
        match key {
            0 => self.subscription = leaf(m)?,
            _ => self.result = m.next_value_seed(Tolerant::new())?,
        }
        Ok(())
    }
}

#[derive(Default)]
struct Res<'a> {
    /// Slot notifications: `result.slot`.
    slot: Field<&'a RawValue>,
    /// Account notifications: `result.context` and `result.value`.
    context: Field<Ctx<'a>>,
    value: Field<Val<'a>>,
}

impl<'de> Shape<'de> for Res<'de> {
    const KEYS: &'static [&'static str] = &["slot", "context", "value"];
    fn read<M: MapAccess<'de>>(&mut self, key: usize, m: &mut M) -> Result<(), M::Error> {
        match key {
            0 => self.slot = leaf(m)?,
            1 => self.context = m.next_value_seed(Tolerant::new())?,
            _ => self.value = m.next_value_seed(Tolerant::new())?,
        }
        Ok(())
    }
}

#[derive(Default)]
struct Ctx<'a> {
    slot: Field<&'a RawValue>,
}

impl<'de> Shape<'de> for Ctx<'de> {
    const KEYS: &'static [&'static str] = &["slot"];
    fn read<M: MapAccess<'de>>(&mut self, _: usize, m: &mut M) -> Result<(), M::Error> {
        self.slot = leaf(m)?;
        Ok(())
    }
}

#[derive(Default)]
struct Val<'a> {
    data: Field<Pair<'a>>,
}

impl<'de> Shape<'de> for Val<'de> {
    const KEYS: &'static [&'static str] = &["data"];
    fn read<M: MapAccess<'de>>(&mut self, _: usize, m: &mut M) -> Result<(), M::Error> {
        self.data = m.next_value_seed(PairSeed(PhantomData))?;
        Ok(())
    }
}

/// `data`: the first two array elements as raw text, and whether more followed.
struct Pair<'a> {
    items: [Option<&'a RawValue>; 2],
    extra: bool,
}

struct PairSeed<'a>(PhantomData<&'a ()>);

impl<'de> DeserializeSeed<'de> for PairSeed<'de> {
    type Value = Field<Pair<'de>>;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for PairSeed<'de> {
    type Value = Field<Pair<'de>>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Self::Value, A::Error> {
        let a = s.next_element::<&'de RawValue>()?;
        let b = if a.is_some() {
            s.next_element::<&'de RawValue>()?
        } else {
            None
        };
        let mut extra = false;
        if b.is_some() {
            while s.next_element::<IgnoredAny>()?.is_some() {
                extra = true;
            }
        }
        Ok(Field::Ok(Pair {
            items: [a, b],
            extra,
        }))
    }
    fn visit_map<M: MapAccess<'de>>(self, mut m: M) -> Result<Self::Value, M::Error> {
        while m.next_key::<IgnoredAny>()?.is_some() {
            m.next_value::<IgnoredAny>()?;
        }
        Ok(Field::Bad)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(Field::Bad)
    }
}
