use keyring::Entry;

const SERVICE: &str = "live-translator";
const ACCOUNT: &str = "gemini-api-key";

fn entry() -> keyring::Result<Entry> {
    Entry::new(SERVICE, ACCOUNT)
}

pub fn get_api_key() -> Option<String> {
    match entry() {
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

pub fn set_api_key(key: &str) -> anyhow::Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("API key must not be empty"));
    }
    Ok(entry()?.set_password(trimmed)?)
}

pub fn delete_api_key() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
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

    // Note: testing get_api_key's trim-on-read and warn-on-error paths requires
    // mocking the keyring crate (which has no mock/test-double support in v3).
    // Those paths are covered by code inspection; full integration tests would
    // need a keyring mock seam that doesn't currently exist in the project.
}
