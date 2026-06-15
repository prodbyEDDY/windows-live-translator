use keyring::Entry;

const SERVICE: &str = "live-translator";
const GEMINI_ACCOUNT: &str = "gemini-api-key";
const ELEVENLABS_ACCOUNT: &str = "elevenlabs-api-key";

fn entry_for(account: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, account)
}

/// Read a stored key for `account`, trimmed; `None` if absent/empty or the
/// keyring errors (logged, never propagated — a missing key is a normal state).
fn get_key(account: &str) -> Option<String> {
    match entry_for(account) {
        Err(e) => {
            tracing::warn!("keyring entry creation failed: {e}");
            None
        }
        Ok(e) => match e.get_password() {
            Ok(val) => {
                let trimmed = val.trim().to_owned();
                if trimmed.is_empty() { None } else { Some(trimmed) }
            }
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!("keyring get_password failed: {e}");
                None
            }
        },
    }
}

/// Store a non-empty key for `account` (trimmed). Empty input is rejected.
fn set_key(account: &str, key: &str) -> anyhow::Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("API key must not be empty"));
    }
    Ok(entry_for(account)?.set_password(trimmed)?)
}

/// Best-effort delete of the stored key for `account`.
fn delete_key(account: &str) {
    if let Ok(e) = entry_for(account) {
        let _ = e.delete_credential();
    }
}

// ── Gemini (unchanged public surface — existing callers keep working) ─────────

pub fn get_api_key() -> Option<String> {
    get_key(GEMINI_ACCOUNT)
}

pub fn set_api_key(key: &str) -> anyhow::Result<()> {
    set_key(GEMINI_ACCOUNT, key)
}

pub fn delete_api_key() {
    delete_key(GEMINI_ACCOUNT);
}

// ── ElevenLabs ────────────────────────────────────────────────────────────────

pub fn get_elevenlabs_api_key() -> Option<String> {
    get_key(ELEVENLABS_ACCOUNT)
}

pub fn set_elevenlabs_api_key(key: &str) -> anyhow::Result<()> {
    set_key(ELEVENLABS_ACCOUNT, key)
}

pub fn delete_elevenlabs_api_key() {
    delete_key(ELEVENLABS_ACCOUNT);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_api_key_rejects_empty() {
        assert!(set_api_key("").is_err());
        assert!(set_api_key("   ").is_err());
        assert!(set_api_key("\t\n").is_err());
    }

    #[test]
    fn set_elevenlabs_key_rejects_empty() {
        assert!(set_elevenlabs_api_key("").is_err());
        assert!(set_elevenlabs_api_key("   ").is_err());
        assert!(set_elevenlabs_api_key("\t\n").is_err());
    }

    // Note: testing get_*_api_key's trim-on-read and warn-on-error paths requires
    // mocking the keyring crate (which has no mock/test-double support in v3).
    // Those paths are covered by code inspection; full integration tests would
    // need a keyring mock seam that doesn't currently exist in the project.
}
