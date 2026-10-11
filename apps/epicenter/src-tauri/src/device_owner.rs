//! The credential-free account captured by an application's local storage.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountIdentity {
    pub authority_id: String,
    pub principal_id: String,
}

pub fn path(account: Option<&AccountIdentity>) -> Result<String, String> {
    let Some(account) = account else {
        return Ok("no-account".into());
    };
    fn encode(value: &str) -> Result<String, String> {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err("Invalid device account identity.".into());
        }
        Ok(value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    }
    Ok(format!(
        "accounts/{}/{}",
        encode(&account.authority_id)?,
        encode(&account.principal_id)?
    ))
}

/// Name of the `accounts/` child that holds one account's portable data
/// folders (ADR-0461), byte for byte what `accountKey` in
/// `packages/principal/src/account-key.ts` derives:
///
/// ```text
/// lowercase_hex(SHA-256(U32BE(byte_length(A)) || A || P))
/// ```
///
/// `A` and `P` are the exact UTF-8 bytes of `authority_id` and
/// `principal_id`; nothing is trimmed, case folded, or normalized. A Rust
/// `String` is always well formed, so the TypeScript lone-surrogate refusal
/// happens where the JSON is parsed. Private device storage keeps using
/// [`path`]; that reversible address is not a portable directory name.
pub fn account_key(account: &AccountIdentity) -> Result<String, String> {
    let invalid = || "Invalid portable account identity.".to_string();
    for value in [&account.authority_id, &account.principal_id] {
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(invalid());
        }
    }
    let authority = account.authority_id.as_bytes();
    let length = u32::try_from(authority.len()).map_err(|_| invalid())?;
    let mut hasher = Sha256::new();
    hasher.update(length.to_be_bytes());
    hasher.update(authority);
    hasher.update(account.principal_id.as_bytes());
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(authority_id: &str, principal_id: &str) -> AccountIdentity {
        AccountIdentity {
            authority_id: authority_id.into(),
            principal_id: principal_id.into(),
        }
    }

    #[test]
    fn wire_identity_matches_the_browser_path_encoding() {
        assert_eq!(path(None).unwrap(), "no-account");
        let account = AccountIdentity {
            authority_id: "a".into(),
            principal_id: "B".into(),
        };
        assert_eq!(path(Some(&account)).unwrap(), "accounts/61/42");
    }

    /// The vectors `account-key.test.ts` pins for the TypeScript derivation.
    #[test]
    fn account_keys_match_the_adr_0461_golden_vectors() {
        for (authority_id, principal_id, expected) in [
            (
                "epicenter-api",
                "user-123",
                "b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7",
            ),
            (
                "instance-68747470733a2f2f6578616d706c652e74657374",
                "instance",
                "478bb60d9394294f671f2c4a5afe2819848e57243d4d319e14f5e8d1fe269653",
            ),
            (
                "A",
                "\u{e9}",
                "1f9770442aa6f99e1fe926643b4ba2cc764e63abaee38dcc6bb158a62c3d4720",
            ),
        ] {
            assert_eq!(
                account_key(&identity(authority_id, principal_id)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn account_keys_hash_identities_without_trimming_folding_or_normalizing() {
        let identities = [
            ("a", "b"),
            ("a", "B"),
            ("A", "b"),
            ("a", "b "),
            (" a", "b"),
            // The length prefix keeps the component boundary in the address.
            ("ab", "c"),
            ("a", "bc"),
            // Precomposed and decomposed forms of one visible character.
            ("a", "\u{e9}"),
            ("a", "e\u{301}"),
        ];
        let keys: std::collections::BTreeSet<String> = identities
            .iter()
            .map(|(authority_id, principal_id)| {
                account_key(&identity(authority_id, principal_id)).unwrap()
            })
            .collect();
        assert_eq!(keys.len(), identities.len());
        assert!(keys.iter().all(|key| key.len() == 64
            && key
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))));
    }

    #[test]
    fn account_keys_refuse_empty_and_control_character_identities() {
        for (authority_id, principal_id) in [
            ("", "user"),
            ("authority", ""),
            ("authority\n", "user"),
            ("authority", "user\u{0}"),
            ("authority", "user\u{85}"),
            ("authority\u{7f}", "user"),
        ] {
            assert!(
                account_key(&identity(authority_id, principal_id)).is_err(),
                "{authority_id:?}/{principal_id:?}"
            );
        }
        // Lone surrogates never reach a Rust string: the JSON parse refuses them.
        for invalid in [
            r#"{"authorityId":"\ud800","principalId":"user"}"#,
            r#"{"authorityId":"authority","principalId":"\udfff"}"#,
        ] {
            assert!(
                serde_json::from_str::<AccountIdentity>(invalid).is_err(),
                "{invalid}"
            );
        }
    }
}
