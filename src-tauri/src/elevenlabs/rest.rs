//! ElevenLabs Text-to-Speech client.
//!
//! Synthesizes translated text into the user's cloned voice via the convert
//! endpoint, requesting raw `pcm_24000` (S16LE, mono, 24 kHz) so the bytes feed
//! straight into [`crate::voice::codec::encode_voice_ogg`] — the same PCM16 @
//! 24 kHz shape Gemini TTS produces, so nothing below synthesis changes.
//! Credential + voice validation hits the get-voice endpoint, which confirms the
//! API key AND that the voice id exists for that account in a single call. The
//! [`KeyStatus`] taxonomy is shared with Gemini (one validation contract).
//!
//! Verified against the real ElevenLabs docs:
//! * convert — `POST /v1/text-to-speech/{voice_id}`, `output_format` is a query
//!   parameter, auth header is `xi-api-key`, body carries `text` + `model_id`.
//! * `pcm_24000` returns raw headerless S16LE 24 kHz mono; only 44.1 kHz PCM/WAV
//!   needs Pro+, and a cloned voice already requires a paid tier.
//! * get-voice — `GET /v1/voices/{voice_id}` with `xi-api-key`.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::gemini::rest::KeyStatus;
use crate::logbus::mask_secret;

const API_BASE: &str = "https://api.elevenlabs.io/v1";

/// Highest-quality multilingual model (29 languages incl. RU/EN/UK). Voice
/// messages are an offline file step, so quality beats the lower-latency
/// Flash/Turbo models.
pub const ELEVEN_MODEL_ID: &str = "eleven_multilingual_v2";

/// Raw PCM at 24 kHz — matches the encoder's input rate; available on the paid
/// tiers a cloned voice already requires (only 44.1 kHz PCM/WAV needs Pro+).
const OUTPUT_FORMAT: &str = "pcm_24000";

/// BCP-47 codes the `eleven_multilingual_v2` model can speak (29 languages).
/// Used to pre-flight a recording's target language before calling convert, so
/// an unsupported language fails fast with a clear error instead of producing
/// garbled or English audio.
pub const ELEVEN_SUPPORTED_LANGS: &[&str] = &[
    "en", "ja", "zh", "de", "hi", "fr", "ko", "pt", "it", "es", "id", "nl", "tr",
    "fil", "pl", "sv", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da",
    "ta", "uk", "ru",
];

/// True if `eleven_multilingual_v2` can synthesize the given BCP-47 language.
pub fn eleven_supports_lang(code: &str) -> bool {
    let lower = code.to_ascii_lowercase();
    ELEVEN_SUPPORTED_LANGS.contains(&lower.as_str())
}

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build elevenlabs reqwest client")
    })
}

/// Full convert URL for `voice_id`, including the `output_format` query.
pub fn convert_url(voice_id: &str) -> String {
    format!("{API_BASE}/text-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}")
}

/// Interpret raw little-endian S16LE bytes as PCM16 samples. A trailing orphan
/// byte (odd length) is dropped. Pure so it is unit-tested at the boundary.
pub fn parse_pcm_s16le(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

/// Classify a get-voice validation response into the shared [`KeyStatus`].
///
/// 200 → Valid; 401/403 → Invalid (bad key); 404/422 → Invalid (voice not
/// found); anything else → Error. The Gemini classifier can't be reused: it maps
/// 404/422 to Error, but here a missing voice must read as Invalid.
pub fn classify_elevenlabs(status: u16, body: &str) -> KeyStatus {
    let snippet: String = body.chars().take(300).collect();
    match status {
        200 => KeyStatus::Valid,
        401 | 403 => KeyStatus::Invalid {
            reason: format!("invalid API key: {snippet}"),
        },
        404 | 422 => KeyStatus::Invalid {
            reason: format!("voice not found: {snippet}"),
        },
        s => KeyStatus::Error {
            message: format!("HTTP {s}: {snippet}"),
        },
    }
}

/// A classified ElevenLabs TTS failure for logging + self-test reporting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenTtsError {
    pub http_status: u16,
    pub code: String,
    pub human: String,
}

/// Map an ElevenLabs error (`status` + response `body`) to a stable code +
/// human sentence. Scans the body for documented status strings first (more
/// specific than the HTTP family), then falls back to the HTTP status. This is
/// the single place the documented ElevenLabs taxonomy is encoded.
pub fn classify_elevenlabs_tts_error(status: u16, body: &str) -> ElevenTtsError {
    let lower = body.to_ascii_lowercase();
    let code = if lower.contains("detected_unusual_activity") {
        "detected_unusual_activity"
    } else if lower.contains("quota_exceeded") || lower.contains("insufficient_credits") {
        "quota_exceeded"
    } else if lower.contains("voice_not_found") {
        "voice_not_found"
    } else if lower.contains("model_not_found") {
        "model_not_found"
    } else if lower.contains("invalid_api_key") {
        "invalid_api_key"
    } else if lower.contains("missing_permission") {
        "missing_permissions"
    } else if lower.contains("text_too_long") {
        "text_too_long"
    } else if lower.contains("concurrent") {
        "concurrent_limit_exceeded"
    } else if lower.contains("rate_limit") || lower.contains("too_many_requests") {
        "rate_limit_exceeded"
    } else {
        match status {
            400 => "validation_error",
            401 => "authentication_error",
            402 => "payment_required",
            403 => "authorization_error",
            404 => "not_found",
            409 => "conflict",
            429 => "rate_limit_error",
            500 => "internal_error",
            503 => "service_unavailable",
            _ => "unknown_error",
        }
    };
    ElevenTtsError {
        http_status: status,
        code: code.to_string(),
        human: human_for_eleven_code(code).to_string(),
    }
}

fn human_for_eleven_code(code: &str) -> &'static str {
    match code {
        "detected_unusual_activity" => "ElevenLabs flagged this IP and disabled Free-tier usage (VPN/datacenter/region). A paid plan or a non-flagged network is required.",
        "quota_exceeded" => "Out of ElevenLabs credits/quota for this billing window.",
        "voice_not_found" => "The voice_id does not exist for this account.",
        "model_not_found" => "The requested model is not available for this account.",
        "invalid_api_key" => "The ElevenLabs API key is invalid.",
        "missing_permissions" => "The API key lacks permission for this voice/model/feature.",
        "text_too_long" => "The text exceeds the per-request character limit.",
        "concurrent_limit_exceeded" => "Too many concurrent ElevenLabs requests.",
        "rate_limit_exceeded" | "rate_limit_error" => "ElevenLabs rate limit hit; retry with backoff.",
        "authentication_error" => "Authentication failed (invalid or missing key).",
        "authorization_error" => "Not authorized for this action.",
        "payment_required" => "Insufficient credits for this operation.",
        "validation_error" => "The request parameters were invalid.",
        "internal_error" => "ElevenLabs internal server error.",
        "service_unavailable" => "ElevenLabs is temporarily unavailable.",
        _ => "Unrecognized ElevenLabs error.",
    }
}

/// A connection-probe result for the self-test (no audio is recorded).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenProbe {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub detail: String,
}

/// Probe the credential + voice via get-voice, logging the exact outcome.
pub async fn probe_validate(api_key: &str, voice_id: &str) -> ElevenProbe {
    let url = format!("{API_BASE}/voices/{voice_id}");
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), key = %mask_secret(api_key), "self-test: validate (get-voice) →");
    match client().get(&url).header("xi-api-key", api_key).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                tracing::info!(target: "elevenlabs", http_status = status, "self-test: validate OK");
                ElevenProbe {
                    ok: true,
                    http_status: Some(status),
                    code: None,
                    detail: "voice found".into(),
                }
            } else {
                let err = classify_elevenlabs_tts_error(status, &body);
                tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %body, "self-test: validate FAILED");
                ElevenProbe {
                    ok: false,
                    http_status: Some(status),
                    code: Some(err.code),
                    detail: err.human,
                }
            }
        }
        Err(e) => {
            let detail = format!("network: {}", e.without_url());
            tracing::error!(target: "elevenlabs", error = %detail, "self-test: validate network error");
            ElevenProbe {
                ok: false,
                http_status: None,
                code: Some("network_error".into()),
                detail,
            }
        }
    }
}

/// Probe synthesis with a tiny phrase, logging the exact outcome.
pub async fn probe_synth(api_key: &str, voice_id: &str, model_id: &str) -> ElevenProbe {
    let url = convert_url(voice_id);
    let body = serde_json::json!({ "text": "Test.", "model_id": model_id });
    let started = Instant::now();
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), model = model_id, "self-test: synth (convert) →");
    match client().post(&url).header("xi-api-key", api_key).json(&body).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                let bytes = resp.bytes().await.map(|b| b.len()).unwrap_or(0);
                let ms = started.elapsed().as_millis() as u64;
                tracing::info!(target: "elevenlabs", http_status = status, bytes, latency_ms = ms, "self-test: synth OK");
                ElevenProbe {
                    ok: true,
                    http_status: Some(status),
                    code: None,
                    detail: format!("{bytes} bytes in {ms} ms"),
                }
            } else {
                let text = resp.text().await.unwrap_or_default();
                let err = classify_elevenlabs_tts_error(status, &text);
                tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %text, "self-test: synth FAILED");
                ElevenProbe {
                    ok: false,
                    http_status: Some(status),
                    code: Some(err.code),
                    detail: err.human,
                }
            }
        }
        Err(e) => {
            let detail = format!("network: {}", e.without_url());
            tracing::error!(target: "elevenlabs", error = %detail, "self-test: synth network error");
            ElevenProbe {
                ok: false,
                http_status: None,
                code: Some("network_error".into()),
                detail,
            }
        }
    }
}

/// Synthesize `text` into the cloned `voice_id` using `model_id`. Returns raw
/// PCM16 mono @ 24 kHz on success.
pub async fn synthesize_elevenlabs(
    api_key: &str,
    voice_id: &str,
    model_id: &str,
    text: &str,
) -> anyhow::Result<Vec<i16>> {
    let url = convert_url(voice_id);
    let body = serde_json::json!({ "text": text, "model_id": model_id });
    let started = Instant::now();
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), key = %mask_secret(api_key), model = model_id, text_len = text.chars().count(), "TTS convert →");
    let resp = client()
        .post(&url)
        .header("xi-api-key", api_key)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        let err = classify_elevenlabs_tts_error(status, &body_text);
        tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %body_text, latency_ms = started.elapsed().as_millis() as u64, "ElevenLabs TTS failed");
        anyhow::bail!("ElevenLabs TTS failed: HTTP {status}: {body_text}");
    }

    let bytes = resp.bytes().await?;
    let pcm = parse_pcm_s16le(&bytes);
    if pcm.is_empty() {
        tracing::error!(target: "elevenlabs", bytes = bytes.len(), "ElevenLabs TTS returned no audio");
        anyhow::bail!("ElevenLabs TTS returned no audio");
    }
    tracing::info!(target: "elevenlabs", samples = pcm.len(), latency_ms = started.elapsed().as_millis() as u64, "TTS convert OK");
    Ok(pcm)
}

/// Validate the key + voice together via get-voice. Network errors → Error.
pub async fn validate_elevenlabs(api_key: &str, voice_id: &str) -> KeyStatus {
    let url = format!("{API_BASE}/voices/{voice_id}");
    match client().get(&url).header("xi-api-key", api_key).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            classify_elevenlabs(status, &body)
        }
        Err(e) => KeyStatus::Error {
            message: format!("network: {}", e.without_url()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pcm_roundtrips_le_samples() {
        let samples = [1i16, -1, 256, -32768, 32767];
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(parse_pcm_s16le(&bytes), samples);
    }

    #[test]
    fn parse_pcm_drops_trailing_orphan_byte() {
        // 3 bytes → one whole sample, last byte dropped.
        assert_eq!(parse_pcm_s16le(&[0x01, 0x00, 0x7f]), vec![1i16]);
        assert_eq!(parse_pcm_s16le(&[]), Vec::<i16>::new());
    }

    #[test]
    fn convert_url_has_voice_and_output_format() {
        let url = convert_url("VOICE42");
        assert_eq!(
            url,
            "https://api.elevenlabs.io/v1/text-to-speech/VOICE42?output_format=pcm_24000"
        );
    }

    #[test]
    fn classify_maps_statuses() {
        assert!(matches!(classify_elevenlabs(200, ""), KeyStatus::Valid));
        assert!(matches!(classify_elevenlabs(401, "x"), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_elevenlabs(403, "x"), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_elevenlabs(404, "x"), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_elevenlabs(422, "x"), KeyStatus::Invalid { .. }));
        assert!(matches!(classify_elevenlabs(429, "x"), KeyStatus::Error { .. }));
        assert!(matches!(classify_elevenlabs(500, "x"), KeyStatus::Error { .. }));
    }

    #[test]
    fn eleven_supports_lang_covers_es_it_not_uz() {
        assert!(eleven_supports_lang("es"));
        assert!(eleven_supports_lang("it"));
        assert!(eleven_supports_lang("ru"));
        assert!(eleven_supports_lang("EN")); // case-insensitive
        // Not in the multilingual_v2 set.
        assert!(!eleven_supports_lang("uz"));
        assert!(!eleven_supports_lang("hy"));
        assert!(!eleven_supports_lang("th"));
    }

    #[test]
    fn classify_tts_error_body_scan_beats_status() {
        // 401 with the unusual-activity marker → specific code, not generic auth.
        let e = classify_elevenlabs_tts_error(
            401,
            r#"{"detail":{"status":"detected_unusual_activity","message":"Unusual activity detected. Free Tier usage disabled."}}"#,
        );
        assert_eq!(e.code, "detected_unusual_activity");
        assert_eq!(e.http_status, 401);
        assert!(!e.human.is_empty());
    }

    #[test]
    fn classify_tts_error_known_codes() {
        assert_eq!(
            classify_elevenlabs_tts_error(404, r#"{"status":"voice_not_found"}"#).code,
            "voice_not_found"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(402, r#"{"status":"quota_exceeded"}"#).code,
            "quota_exceeded"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(400, r#"{"status":"text_too_long"}"#).code,
            "text_too_long"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(429, r#"{"status":"too_many_concurrent"}"#).code,
            "concurrent_limit_exceeded"
        );
    }

    #[test]
    fn classify_tts_error_falls_back_to_status_family() {
        assert_eq!(
            classify_elevenlabs_tts_error(401, "opaque").code,
            "authentication_error"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(403, "opaque").code,
            "authorization_error"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(500, "boom").code,
            "internal_error"
        );
        assert_eq!(
            classify_elevenlabs_tts_error(418, "teapot").code,
            "unknown_error"
        );
    }

    #[test]
    fn classify_truncates_long_body() {
        let long = "x".repeat(500);
        match classify_elevenlabs(404, &long) {
            KeyStatus::Invalid { reason } => {
                // "voice not found: " + 300 chars
                assert!(reason.starts_with("voice not found: "));
                assert_eq!(reason.chars().filter(|&c| c == 'x').count(), 300);
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID env"]
    async fn real_synthesize_smoke() {
        let key = std::env::var("ELEVENLABS_API_KEY").unwrap();
        let voice = std::env::var("ELEVENLABS_VOICE_ID").unwrap();
        let pcm = synthesize_elevenlabs(&key, &voice, ELEVEN_MODEL_ID, "Hello, world!")
            .await
            .expect("synth should succeed");
        assert!(!pcm.is_empty());
        println!("ElevenLabs smoke: {} samples", pcm.len());
    }

    #[tokio::test]
    #[ignore = "needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID env"]
    async fn real_validate_smoke() {
        let key = std::env::var("ELEVENLABS_API_KEY").unwrap();
        let voice = std::env::var("ELEVENLABS_VOICE_ID").unwrap();
        assert!(matches!(
            validate_elevenlabs(&key, &voice).await,
            KeyStatus::Valid
        ));
    }
}
