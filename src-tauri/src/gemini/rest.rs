use std::sync::OnceLock;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use base64::Engine as _;

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

static SLOW_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn slow_client() -> &'static reqwest::Client {
    SLOW_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build 120s reqwest client")
    })
}

// ── TTS ─────────────────────────────────────────────────────────────────────

/// All pre-built voice names available for `gemini-3.1-flash-tts-preview`.
pub const TTS_VOICES: &[&str] = &[
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

/// Extract PCM16 samples from a `generateContent` response value.
///
/// Looks in `candidates[0].content.parts[*].inlineData` for parts whose
/// `mimeType` starts with `"audio/"`, base64-decodes the data, interprets
/// the bytes as little-endian i16 samples, and concatenates all audio parts.
/// Text parts and parts with non-audio MIME types are silently skipped.
/// Returns `None` when no audio parts are found or the input shape is wrong.
pub fn extract_tts_pcm(v: &serde_json::Value) -> Option<Vec<i16>> {
    let parts = v
        .pointer("/candidates/0/content/parts")
        .and_then(|p| p.as_array())?;

    let mut out: Vec<i16> = Vec::new();
    let mut found_audio = false;

    for part in parts {
        let inline = match part.get("inlineData").or_else(|| part.get("inline_data")) {
            Some(d) => d,
            None => continue, // text part or unknown — skip
        };
        let mime = inline.get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        if !mime.starts_with("audio/") {
            continue;
        }
        let b64 = inline.get("data").and_then(|d| d.as_str()).unwrap_or("");
        let mut bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.len() % 2 != 0 {
            bytes.pop(); // drop trailing orphan byte
        }
        out.extend(
            bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])),
        );
        found_audio = true;
    }

    if found_audio { Some(out) } else { None }
}

/// Synthesize `text` to PCM16 mono 24 kHz audio using `gemini-3.1-flash-tts-preview`.
///
/// `voice` must be one of the names in [`TTS_VOICES`].
/// Returns raw signed-16-bit little-endian samples at 24 kHz.
pub async fn synthesize_speech(
    api_key: &str,
    text: &str,
    voice: &str,
) -> anyhow::Result<Vec<i16>> {
    let url = format!("{BASE}/models/gemini-3.1-flash-tts-preview:generateContent");
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": text }] }],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": { "voiceName": voice }
                }
            }
        }
    });

    let resp = slow_client()
        .post(&url)
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        anyhow::bail!("TTS generateContent failed: HTTP {status}: {body_text}");
    }

    let json: serde_json::Value = resp.json().await?;
    extract_tts_pcm(&json)
        .ok_or_else(|| anyhow::anyhow!("TTS response contained no audio parts: {json}"))
}

// ── Voice transcription ──────────────────────────────────────────────────────

/// Returned by `transcribe_translate`. Field names match the JSON the model produces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscription {
    pub source_lang: String,
    pub transcript: String,
    pub translation: String,
}

/// Strip optional ```json fences, then find the first `{…}` block and parse it.
/// Returns `None` when the text contains no valid JSON object or the fields are wrong.
pub fn parse_voice_json(text: &str) -> Option<VoiceTranscription> {
    // 1. Strip ```json … ``` fences (or plain ``` fences).
    let stripped = {
        let t = text.trim();
        // Remove leading fence line
        let t = if let Some(rest) = t.strip_prefix("```json") {
            rest
        } else if let Some(rest) = t.strip_prefix("```") {
            rest
        } else {
            t
        };
        // Remove trailing fence line
        let t = if let Some(rest) = t.strip_suffix("```") {
            rest
        } else {
            t
        };
        t.trim()
    };

    // 2. Find the first `{` … matching `}` by counting braces.
    let start = stripped.find('{')?;
    let bytes = stripped.as_bytes();
    let mut depth: i32 = 0;
    let mut end = None;
    for (i, &b) in bytes[start..].iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let json_slice = &stripped[start..=end?];

    serde_json::from_str(json_slice).ok()
}

/// Upload `audio` to the Gemini Files API via a resumable upload when `audio` > 20 MB.
/// Returns the `file_uri` to use in a `file_data` part.
async fn upload_audio_file(
    api_key: &str,
    audio: &[u8],
    mime: &str,
) -> anyhow::Result<String> {
    // Step 1: Start the resumable upload session.
    let start_url = format!(
        "https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}"
    );
    let metadata = serde_json::json!({ "file": { "displayName": "voice_audio" } });
    let start_resp = slow_client()
        .post(&start_url)
        .header("X-Goog-Upload-Protocol", "resumable")
        .header("X-Goog-Upload-Command", "start")
        .header("X-Goog-Upload-Header-Content-Length", audio.len().to_string())
        .header("X-Goog-Upload-Header-Content-Type", mime)
        .header("x-goog-api-key", api_key)
        .json(&metadata)
        .send()
        .await?;

    let upload_url = start_resp
        .headers()
        .get("X-Goog-Upload-URL")
        .ok_or_else(|| anyhow::anyhow!("Files API did not return X-Goog-Upload-URL"))?
        .to_str()?
        .to_owned();

    // Step 2: Upload the bytes.
    let upload_resp = slow_client()
        .post(&upload_url)
        .header("X-Goog-Upload-Command", "upload, finalize")
        .header("X-Goog-Upload-Offset", "0")
        .header("Content-Type", mime)
        .body(audio.to_vec())
        .send()
        .await?;

    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        anyhow::bail!("Files API upload failed: HTTP {status}: {body}");
    }

    let upload_json: serde_json::Value = upload_resp.json().await?;
    let uri = upload_json["file"]["uri"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Files API response missing file.uri: {upload_json}"))?
        .to_owned();
    Ok(uri)
}

fn build_prompt(target_lang: &str) -> String {
    format!(
        "Transcribe this audio, then translate the transcript into {target_lang} (BCP-47). \
Reply with ONLY a JSON object: {{\"sourceLang\": \"<BCP-47>\", \"transcript\": \"...\", \"translation\": \"...\"}}"
    )
}

async fn call_generate_content(
    api_key: &str,
    body: &serde_json::Value,
) -> anyhow::Result<String> {
    let url = format!("{BASE}/models/gemini-3.5-flash:generateContent");
    let resp = slow_client()
        .post(&url)
        .header("x-goog-api-key", api_key)
        .json(body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        anyhow::bail!("generateContent failed: HTTP {status}: {body_text}");
    }

    let json: serde_json::Value = resp.json().await?;
    // Collect all text parts from candidates[0].content.parts[*].text
    let parts = json
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("unexpected generateContent response shape: {json}"))?;

    let text = parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("");

    Ok(text)
}

/// Transcribe `audio` and translate into `target_lang` (BCP-47) using Gemini REST.
///
/// Uses `gemini-3.5-flash` `generateContent`. Audio ≤20 MB is sent as `inline_data`
/// (base64); larger files are uploaded via the Files API first.
pub async fn transcribe_translate(
    api_key: &str,
    audio: &[u8],
    mime: &str,
    target_lang: &str,
) -> anyhow::Result<VoiceTranscription> {
    const TWENTY_MB: usize = 20 * 1024 * 1024;

    let prompt = build_prompt(target_lang);

    // For files over 20 MB we upload ONCE via the Files API and reuse the
    // resulting `file_uri` for both the first attempt and the retry. Re-uploading
    // on retry doubled the (slow) upload for large clips for no benefit — the
    // returned uri is valid for the whole `transcribe_translate` call.
    let uploaded_uri = if audio.len() <= TWENTY_MB {
        None
    } else {
        Some(upload_audio_file(api_key, audio, mime).await?)
    };

    // Build the parts for a given prompt, reusing the uploaded uri when present
    // and falling back to inline base64 for small files.
    let build_contents = |prompt: &str| {
        if let Some(file_uri) = &uploaded_uri {
            serde_json::json!([{
                "parts": [
                    { "file_data": { "mime_type": mime, "file_uri": file_uri } },
                    { "text": prompt }
                ]
            }])
        } else {
            let b64 = base64::engine::general_purpose::STANDARD.encode(audio);
            serde_json::json!([{
                "parts": [
                    { "inline_data": { "mime_type": mime, "data": b64 } },
                    { "text": prompt }
                ]
            }])
        }
    };

    let body = serde_json::json!({ "contents": build_contents(&prompt) });

    // First attempt.
    let text = call_generate_content(api_key, &body).await?;
    if let Some(result) = parse_voice_json(&text) {
        return Ok(result);
    }

    // Retry with a stricter instruction appended (reusing the same `file_uri`
    // for the >20 MB path — no second upload).
    let retry_prompt = format!(
        "{prompt}\nReply with ONLY the JSON object, no other text."
    );
    let retry_body = serde_json::json!({ "contents": build_contents(&retry_prompt) });
    let retry_text = call_generate_content(api_key, &retry_body).await?;
    parse_voice_json(&retry_text)
        .ok_or_else(|| anyhow::anyhow!("model returned unparseable JSON after retry: {retry_text}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum KeyStatus {
    Missing,
    Valid,
    Invalid { reason: String },
    Error { message: String },
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── TTS voices ──────────────────────────────────────────────────────────

    #[test]
    fn tts_voices_contains_kore_and_has_enough_entries() {
        assert!(TTS_VOICES.contains(&"Kore"), "TTS_VOICES must contain 'Kore'");
        assert!(
            TTS_VOICES.len() >= 20,
            "expected at least 20 voices, got {}",
            TTS_VOICES.len()
        );
    }

    // ── extract_tts_pcm ──────────────────────────────────────────────────────

    fn make_b64_pcm(samples: &[i16]) -> String {
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn extract_tts_pcm_fixture_two_audio_parts_plus_text_part() {
        // Part 0: audio with samples [1, 2]
        let b64_a = make_b64_pcm(&[1i16, 2]);
        // Part 1: text part — must be skipped
        // Part 2: audio with samples [3, -1]
        let b64_b = make_b64_pcm(&[3i16, -1]);

        let v = serde_json::json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "inlineData": { "mimeType": "audio/pcm", "data": b64_a } },
                        { "text": "some transcription text" },
                        { "inlineData": { "mimeType": "audio/L16;rate=24000", "data": b64_b } }
                    ]
                }
            }]
        });

        let pcm = extract_tts_pcm(&v).expect("should extract PCM from fixture");
        assert_eq!(pcm, vec![1i16, 2, 3, -1], "must concatenate both audio parts in order");
    }

    #[test]
    fn extract_tts_pcm_returns_none_on_garbage() {
        assert!(extract_tts_pcm(&serde_json::json!({})).is_none());
        assert!(extract_tts_pcm(&serde_json::json!(null)).is_none());
        assert!(extract_tts_pcm(&serde_json::json!({"candidates": []})).is_none());
        // parts present but all text — no audio
        let v = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "hello" }] } }]
        });
        assert!(extract_tts_pcm(&v).is_none());
    }

    #[tokio::test]
    #[ignore = "needs real key in GEMINI_API_KEY env"]
    async fn real_tts_smoke() {
        let key = std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY not set");
        let pcm = synthesize_speech(&key, "Hello, world!", "Kore")
            .await
            .expect("TTS should succeed");
        assert!(!pcm.is_empty(), "should return at least one PCM sample");
        println!("TTS smoke: {} samples", pcm.len());
    }

    // ── parse_voice_json ─────────────────────────────────────────────────────

    #[test]
    fn parse_voice_json_clean() {
        let json = r#"{"sourceLang":"ru","transcript":"Привет","translation":"Hello"}"#;
        let result = parse_voice_json(json).expect("should parse clean JSON");
        assert_eq!(result.source_lang, "ru");
        assert_eq!(result.transcript, "Привет");
        assert_eq!(result.translation, "Hello");
    }

    #[test]
    fn parse_voice_json_fenced() {
        let json = "```json\n{\"sourceLang\":\"es\",\"transcript\":\"Hola\",\"translation\":\"Hello\"}\n```";
        let result = parse_voice_json(json).expect("should parse fenced JSON");
        assert_eq!(result.source_lang, "es");
        assert_eq!(result.translation, "Hello");
    }

    #[test]
    fn parse_voice_json_prose_surrounded() {
        let json = r#"Here is the result: {"sourceLang":"de","transcript":"Hallo","translation":"Hello"} — done."#;
        let result = parse_voice_json(json).expect("should parse prose-surrounded JSON");
        assert_eq!(result.source_lang, "de");
        assert_eq!(result.transcript, "Hallo");
    }

    #[test]
    fn parse_voice_json_garbage_returns_none() {
        assert!(parse_voice_json("this is total garbage with no json").is_none());
        assert!(parse_voice_json("").is_none());
        assert!(parse_voice_json("{}").is_none()); // missing required fields
        assert!(parse_voice_json(r#"{"wrong":"fields"}"#).is_none());
    }

    #[test]
    fn parse_voice_json_plain_fence() {
        let json = "```\n{\"sourceLang\":\"fr\",\"transcript\":\"Bonjour\",\"translation\":\"Hello\"}\n```";
        let result = parse_voice_json(json).expect("should parse plain-fenced JSON");
        assert_eq!(result.source_lang, "fr");
    }

    // ── real API smoke test ──────────────────────────────────────────────────

    #[tokio::test]
    #[ignore = "needs real key in GEMINI_API_KEY env"]
    async fn real_transcribe_smoke() {
        let key = std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY not set");
        // Use a minimal silent WAV (44 bytes header + 0 samples) as audio fixture.
        // A real test would use a genuine speech clip.
        let wav: Vec<u8> = {
            let mut w = Vec::new();
            // RIFF header for a 0-sample 16-bit 16kHz mono WAV
            w.extend_from_slice(b"RIFF");
            w.extend_from_slice(&36u32.to_le_bytes()); // chunk size (no data)
            w.extend_from_slice(b"WAVEfmt ");
            w.extend_from_slice(&16u32.to_le_bytes()); // subchunk1 size
            w.extend_from_slice(&1u16.to_le_bytes());  // PCM
            w.extend_from_slice(&1u16.to_le_bytes());  // mono
            w.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
            w.extend_from_slice(&32000u32.to_le_bytes()); // byte rate
            w.extend_from_slice(&2u16.to_le_bytes());  // block align
            w.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
            w.extend_from_slice(b"data");
            w.extend_from_slice(&0u32.to_le_bytes());  // 0 bytes of audio
            w
        };
        let result = transcribe_translate(&key, &wav, "audio/wav", "en").await;
        // We just verify it doesn't hard-error (empty audio may return empty transcript).
        println!("smoke result: {result:?}");
    }

    // ── classify_validation ──────────────────────────────────────────────────

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
