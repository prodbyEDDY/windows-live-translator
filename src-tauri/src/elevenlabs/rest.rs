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
use std::time::Duration;

use crate::gemini::rest::KeyStatus;

const API_BASE: &str = "https://api.elevenlabs.io/v1";

/// Highest-quality multilingual model (29 languages incl. RU/EN/UK). Voice
/// messages are an offline file step, so quality beats the lower-latency
/// Flash/Turbo models.
pub const ELEVEN_MODEL_ID: &str = "eleven_multilingual_v2";

/// Raw PCM at 24 kHz — matches the encoder's input rate; available on the paid
/// tiers a cloned voice already requires (only 44.1 kHz PCM/WAV needs Pro+).
const OUTPUT_FORMAT: &str = "pcm_24000";

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
    let resp = client()
        .post(&url)
        .header("xi-api-key", api_key)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        anyhow::bail!("ElevenLabs TTS failed: HTTP {status}: {body_text}");
    }

    let bytes = resp.bytes().await?;
    let pcm = parse_pcm_s16le(&bytes);
    if pcm.is_empty() {
        anyhow::bail!("ElevenLabs TTS returned no audio");
    }
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
