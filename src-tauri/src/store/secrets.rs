use keyring::Entry;

const SERVICE: &str = "live-translator";
const ACCOUNT: &str = "gemini-api-key";

fn entry() -> keyring::Result<Entry> {
    Entry::new(SERVICE, ACCOUNT)
}

pub fn get_api_key() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn set_api_key(key: &str) -> anyhow::Result<()> {
    Ok(entry()?.set_password(key.trim())?)
}

pub fn delete_api_key() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}
