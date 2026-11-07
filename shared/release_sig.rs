//! Release signatures. The zip of a release is signed with the maintainer's key
//! (`srcipts/release-sign.mjs`, public half in `keys/update.pub`) and the signature is published
//! next to it as `<zip name>.sig`. The launcher's self-update and the installer both include this
//! file (`#[path]`), refuse a zip whose signature does not match, and so do not run what someone
//! who merely controls a release page uploaded.
//!
//! The signature covers the zip's SHA-256 *and* the release version, so an old, genuinely signed
//! zip cannot be served again under a newer tag to push users back to a vulnerable build.

use ed25519_compact::{PublicKey, Signature};

/// 64 hex digits: the key releases are signed with.
const PUBLIC_KEY_HEX: &str = include_str!("../keys/update.pub");

/// What is signed. Must stay the same as `message` in `srcipts/release-sign.mjs`.
fn message(version: &str, sha256: &[u8]) -> String {
    let hex: String = sha256.iter().map(|b| format!("{b:02x}")).collect();
    format!("nihao-release-v1\n{version}\n{hex}\n")
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

/// `sha256`: the digest of the zip as downloaded. `signature_hex`: the text of the `.sig` file.
/// `version` is the release tag without its leading `v`.
pub fn verify(version: &str, sha256: &[u8], signature_hex: &str) -> Result<(), String> {
    verify_with(PUBLIC_KEY_HEX, version, sha256, signature_hex)
}

fn verify_with(key_hex: &str, version: &str, sha256: &[u8], signature_hex: &str) -> Result<(), String> {
    let key = from_hex(key_hex)
        .and_then(|b| PublicKey::from_slice(&b).ok())
        .ok_or("the update key built into this program is damaged")?;
    let signature = from_hex(signature_hex)
        .and_then(|b| Signature::from_slice(&b).ok())
        .ok_or("the release signature is not a valid signature file")?;
    key.verify(message(version, sha256), &signature)
        .map_err(|_| format!("the release signature does not match this download of version {version}"))
}

#[cfg(test)]
mod release_sig_tests {
    use super::*;
    use ed25519_compact::{KeyPair, Seed};

    fn signed(version: &str, sha256: &[u8]) -> (String, String) {
        let pair = KeyPair::from_seed(Seed::new([7; 32]));
        let signature = pair.sk.sign(message(version, sha256), None);
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        (hex(&*pair.pk), hex(&*signature))
    }

    #[test]
    fn a_matching_signature_passes_and_anything_else_fails() {
        let digest = [1u8; 32];
        let (key, signature) = signed("0.2.0", &digest);
        assert!(verify_with(&key, "0.2.0", &digest, &signature).is_ok());
        assert!(verify_with(&key, "0.2.0", &digest, &format!("{signature}\n")).is_ok(), "a trailing newline is fine");
        // Another file, another version (an old signed zip under a newer tag), a mangled signature.
        assert!(verify_with(&key, "0.2.0", &[2u8; 32], &signature).is_err());
        assert!(verify_with(&key, "0.3.0", &digest, &signature).is_err());
        let mut flipped = signature.clone();
        flipped.replace_range(0..1, if signature.starts_with('0') { "1" } else { "0" });
        assert!(verify_with(&key, "0.2.0", &digest, &flipped).is_err());
        assert!(verify_with(&key, "0.2.0", &digest, "not hex").is_err());
        assert!(verify_with("zz", "0.2.0", &digest, &signature).is_err());
    }

    /// Checks a zip signed by the script against the key built into this program:
    /// `NIHAO_TEST_ZIP=release.zip NIHAO_TEST_VERSION=0.1.0 cargo test -p nihao-client signed_by_the_script -- --ignored`
    #[test]
    #[ignore]
    fn a_zip_signed_by_the_script_passes() {
        use sha2::{Digest, Sha256};
        let zip = std::path::PathBuf::from(std::env::var("NIHAO_TEST_ZIP").expect("set NIHAO_TEST_ZIP"));
        let version = std::env::var("NIHAO_TEST_VERSION").expect("set NIHAO_TEST_VERSION");
        let signature = std::fs::read_to_string(format!("{}.sig", zip.display())).unwrap();
        let digest = Sha256::digest(std::fs::read(&zip).unwrap());
        verify(&version, &digest, &signature).unwrap();
        assert!(verify("9.9.9", &digest, &signature).is_err());
    }

    #[test]
    fn the_key_built_into_the_program_is_a_real_key() {
        assert!(from_hex(PUBLIC_KEY_HEX).and_then(|b| PublicKey::from_slice(&b).ok()).is_some());
    }
}
