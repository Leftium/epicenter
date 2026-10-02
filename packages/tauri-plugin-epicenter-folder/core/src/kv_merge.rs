//! Pure root-key reconciliation, matching `@epicenter/folder`'s `mergeKv`.
//! Selected JSON value text survives. No schema, Git, or file publication runs.

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Base,
    Ours,
    Theirs,
}

/// Raw JSON values; `None` means a missing key, not JSON null.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct KeyConflict {
    pub key: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum KvMerge {
    Merged { source: Option<String> },
    Conflict { conflicts: Vec<KeyConflict> },
    FileConflict,
    Invalid { side: Side },
}

#[derive(Debug, PartialEq, Eq)]
enum Value {
    Literal(String),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

struct Member<'a> {
    raw: &'a str,
    value: Value,
}

type Document<'a> = BTreeMap<String, Member<'a>>;

// Read pairs before collecting a map so duplicate decoded keys stay visible.
struct Entries<'a>(Vec<(String, &'a RawValue)>);

impl<'de> Deserialize<'de> for Entries<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor;
        impl<'de> Visitor<'de> for EntriesVisitor {
            type Value = Entries<'de>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut pairs = Vec::new();
                while let Some(pair) = map.next_entry::<String, &'de RawValue>()? {
                    pairs.push(pair);
                }
                Ok(Entries(pairs))
            }
        }
        deserializer.deserialize_map(EntriesVisitor)
    }
}

/// Bound recursive decoding before entering it; quoted brackets add no depth.
fn within_depth(source: &str) -> bool {
    let mut closing = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    for byte in source.bytes() {
        if quoted {
            if byte < b' ' {
                return false;
            }
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' | b'[' => {
                closing.push(if byte == b'{' { b'}' } else { b']' });
                if closing.len() > 64 {
                    return false;
                }
            }
            b'}' | b']' => {
                if closing.pop() != Some(byte) {
                    return false;
                }
            }
            b'/' => return false,
            _ => {}
        }
    }
    !quoted && closing.is_empty()
}

fn read_value(raw: &RawValue) -> Option<Value> {
    match raw.get().as_bytes().first()? {
        b'"' => Some(Value::String(serde_json::from_str(raw.get()).ok()?)),
        b'{' => {
            let entries: Entries<'_> = serde_json::from_str(raw.get()).ok()?;
            let mut members = BTreeMap::new();
            for (key, child) in entries.0 {
                if members.contains_key(&key) {
                    return None;
                }
                members.insert(key, read_value(child)?);
            }
            Some(Value::Object(members))
        }
        b'[' => {
            let children: Vec<&RawValue> = serde_json::from_str(raw.get()).ok()?;
            let items: Option<Vec<Value>> = children.into_iter().map(read_value).collect();
            Some(Value::Array(items?))
        }
        // RawValue validated the token without converting a number to f64.
        _ => Some(Value::Literal(raw.get().to_owned())),
    }
}

fn read(source: Option<&str>) -> Result<Option<Document<'_>>, ()> {
    let Some(source) = source else {
        return Ok(None);
    };
    if !within_depth(source) {
        return Err(());
    }
    let text = source.strip_prefix('\u{feff}').unwrap_or(source);
    let entries: Entries<'_> = serde_json::from_str(text).map_err(|_| ())?;
    let mut members = BTreeMap::new();
    for (key, raw) in entries.0 {
        if members.contains_key(&key) {
            return Err(());
        }
        members.insert(
            key,
            Member {
                raw: raw.get(),
                value: read_value(raw).ok_or(())?,
            },
        );
    }
    Ok(Some(members))
}

fn same_file(left: &Document<'_>, right: &Document<'_>) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .all(|(key, member)| right.get(key).is_some_and(|r| member.value == r.value))
}

/// Prepare a complete source or conflicts without publishing anything.
///
/// `None` means no file; empty text is invalid. Nested objects and arrays are
/// atomic merge units. Equality ignores object order and string escape spelling,
/// but numeric tokens are exact: `1` and `1.0` differ. Duplicate keys at any
/// depth, unpaired surrogates, and nesting beyond 64 containers refuse merging.
/// A whole-file deletion against a value change is a file conflict.
///
/// Output has sorted root keys and canonical framing, without a BOM. Chosen
/// value spans survive, and equal choices use the smaller UTF-8 spelling so
/// swapping ours and theirs produces the same successful source.
pub fn merge_kv(base: Option<&str>, ours: Option<&str>, theirs: Option<&str>) -> KvMerge {
    let b = match read(base) {
        Ok(value) => value,
        Err(()) => return KvMerge::Invalid { side: Side::Base },
    };
    let o = match read(ours) {
        Ok(value) => value,
        Err(()) => return KvMerge::Invalid { side: Side::Ours },
    };
    let t = match read(theirs) {
        Ok(value) => value,
        Err(()) => return KvMerge::Invalid { side: Side::Theirs },
    };
    if o.is_none() || t.is_none() {
        let Some(present) = o.as_ref().or(t.as_ref()) else {
            return KvMerge::Merged { source: None };
        };
        if let Some(base) = b.as_ref() {
            return if same_file(base, present) {
                KvMerge::Merged { source: None }
            } else {
                KvMerge::FileConflict
            };
        }
    }

    let mut keys = BTreeSet::new();
    for document in [b.as_ref(), o.as_ref(), t.as_ref()].into_iter().flatten() {
        keys.extend(document.keys());
    }
    let mut conflicts = Vec::new();
    let mut members = Vec::new();
    for key in keys {
        let before = b.as_ref().and_then(|map| map.get(key));
        let left = o.as_ref().and_then(|map| map.get(key));
        let right = t.as_ref().and_then(|map| map.get(key));
        let selected = if left.map(|m| &m.value) == right.map(|m| &m.value) {
            match (left, right) {
                (Some(left), Some(right)) => Some(if left.raw <= right.raw { left } else { right }),
                _ => left.or(right),
            }
        } else if left.map(|m| &m.value) == before.map(|m| &m.value) {
            right
        } else if right.map(|m| &m.value) == before.map(|m| &m.value) {
            left
        } else {
            conflicts.push(KeyConflict {
                key: key.clone(),
                base: before.map(|m| m.raw.to_owned()),
                ours: left.map(|m| m.raw.to_owned()),
                theirs: right.map(|m| m.raw.to_owned()),
            });
            continue;
        };
        if let Some(member) = selected {
            let name = serde_json::to_string(key).expect("a string always serializes");
            members.push(format!("  {name}: {}", member.raw));
        }
    }
    if !conflicts.is_empty() {
        return KvMerge::Conflict { conflicts };
    }
    KvMerge::Merged {
        source: Some(if members.is_empty() {
            "{}\n".into()
        } else {
            format!("{{\n{}\n}}\n", members.join(",\n"))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        base: Option<String>,
        ours: Option<String>,
        theirs: Option<String>,
        expected: serde_json::Value,
    }

    #[test]
    fn shared_vectors_match_typescript_and_preserve_selected_source() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../fixtures/kv-merge.json")).unwrap();
        for case in cases {
            let result = merge_kv(
                case.base.as_deref(),
                case.ours.as_deref(),
                case.theirs.as_deref(),
            );
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                case.expected,
                "{}",
                case.name
            );
            if matches!(result, KvMerge::Merged { .. } | KvMerge::FileConflict) {
                assert_eq!(
                    merge_kv(
                        case.base.as_deref(),
                        case.theirs.as_deref(),
                        case.ours.as_deref()
                    ),
                    result,
                    "{}: swapping sides",
                    case.name
                );
            }
            if let KvMerge::Merged { source } = &result {
                assert_eq!(
                    merge_kv(source.as_deref(), source.as_deref(), source.as_deref()),
                    result,
                    "{}: output remains valid and stable",
                    case.name
                );
            }
            if let KvMerge::Conflict { conflicts } = &result {
                let swapped = conflicts
                    .iter()
                    .map(|c| KeyConflict {
                        key: c.key.clone(),
                        base: c.base.clone(),
                        ours: c.theirs.clone(),
                        theirs: c.ours.clone(),
                    })
                    .collect();
                assert_eq!(
                    merge_kv(
                        case.base.as_deref(),
                        case.theirs.as_deref(),
                        case.ours.as_deref()
                    ),
                    KvMerge::Conflict { conflicts: swapped },
                    "{}: swapping conflict sides",
                    case.name
                );
            }
        }
    }
}
