use std::sync::OnceLock;
use std::time::Duration;
use serde::Serialize;

pub const BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest client")
    })
}

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

    #[test]
    fn classify_validation_truncates_long_body() {
        let long_body: String = "x".repeat(500);
        match classify_validation(400, &long_body) {
            KeyStatus::Invalid { reason } => assert_eq!(reason.chars().count(), 300),
            other => panic!("expected Invalid, got {other:?}"),
        }
        match classify_validation(500, &long_body) {
            KeyStatus::Error { message } => {
                // message is "HTTP 500: " + up to 300 chars
                assert!(message.chars().count() <= "HTTP 500: ".len() + 300);
                // the snippet portion is exactly 300 chars
                let prefix = "HTTP 500: ";
                let snippet = &message[prefix.len()..];
                assert_eq!(snippet.chars().count(), 300);
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "needs real key in GEMINI_API_KEY env"]
    async fn validates_real_key() {
        let key = std::env::var("GEMINI_API_KEY").unwrap();
        assert!(matches!(validate_key(&key).await, KeyStatus::Valid));
    }
}

pub fn classify_validation(status: u16, body: &str) -> KeyStatus {
    let snippet: String = body.chars().take(300).collect();
    match status {
        200 => KeyStatus::Valid,
        400 | 401 | 403 => KeyStatus::Invalid { reason: snippet },
        s => KeyStatus::Error { message: format!("HTTP {s}: {snippet}") },
    }
}

pub async fn validate_key(key: &str) -> KeyStatus {
    let url = format!("{BASE}/models?pageSize=1");
    match client().get(&url).header("x-goog-api-key", key).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            classify_validation(status, &body)
        }
        Err(e) => KeyStatus::Error { message: format!("network: {}", e.without_url()) },
    }
}
