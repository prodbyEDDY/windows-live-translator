use serde::Serialize;

pub const BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum KeyStatus {
    Missing,
    Valid,
    Invalid { reason: String },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify_statuses() {
        assert!(matches!(classify_validation(200, ""), KeyStatus::Valid));
        assert!(matches!(classify_validation(400, "API_KEY_INVALID"), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_validation(403, ""), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_validation(429, ""), KeyStatus::Error { .. }));
        assert!(matches!(classify_validation(500, ""), KeyStatus::Error { .. }));
    }

    #[tokio::test]
    #[ignore = "needs real key in GEMINI_API_KEY env"]
    async fn validates_real_key() {
        let key = std::env::var("GEMINI_API_KEY").unwrap();
        assert!(matches!(validate_key(&key).await, KeyStatus::Valid));
    }
}

pub fn classify_validation(status: u16, body: &str) -> KeyStatus {
    match status {
        200 => KeyStatus::Valid,
        400 | 401 | 403 => KeyStatus::Invalid { reason: body.chars().take(300).collect() },
        s => KeyStatus::Error { message: format!("HTTP {s}: {}", body.chars().take(300).collect::<String>()) },
    }
}

pub async fn validate_key(key: &str) -> KeyStatus {
    let url = format!("{BASE}/models?pageSize=1&key={key}");
    match reqwest::get(&url).await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            classify_validation(status, &body)
        }
        Err(e) => KeyStatus::Error { message: format!("network: {e}") },
    }
}
