use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

pub const LIVE_MODEL: &str = "models/gemini-3.5-live-translate-preview";
pub const WS_URL: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

pub fn setup_message(target_lang: &str, echo: bool, resume_handle: Option<&str>) -> Value {
    let resumption = match resume_handle {
        Some(h) => json!({ "handle": h }),
        None => json!({}),
    };
    // Wire shape per the official google-genai SDK converters
    // (_LiveConnectConfig_to_mldev): the transcription configs and
    // sessionResumption are TOP-LEVEL setup fields; only responseModalities and
    // translationConfig nest under generationConfig. The JSON sample on the
    // live-translate docs page nests the transcriptions inside generationConfig
    // — that shape makes the server reject the setup (connection hangs).
    json!({ "setup": {
        "model": LIVE_MODEL,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "translationConfig": { "targetLanguageCode": target_lang, "echoTargetLanguage": echo }
        },
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "sessionResumption": resumption
    }})
}

/// A classified Live-session failure: a stable reason token (with a short human
/// detail) plus whether the failure is *permanent* (no point retrying — surface
/// it immediately) or transient (worth a reconnect).
///
/// `reason` is shaped `"gemini_<token>: <detail>"` so the frontend can map the
/// leading token to localized copy (quota / auth / model / …) while still
/// showing the raw server detail for diagnosis.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveFailure {
    pub reason: String,
    pub permanent: bool,
}

/// Classify a Live WebSocket failure from an optional HTTP status (handshake
/// rejection) and a body / close-frame reason `text`.
///
/// Recognizes the cases a user most needs spelled out — an exhausted balance /
/// quota / rate limit, a bad API key or missing permission, and an unavailable
/// model — and marks them permanent so the session fails fast with a clear
/// message instead of silently burning six reconnect attempts. Anything else
/// falls back to `fallback_token` and is treated as transient (retryable).
pub fn classify_live_failure(
    http_status: Option<u16>,
    text: &str,
    fallback_token: &str,
) -> LiveFailure {
    let lower = text.to_lowercase();
    let has = |needle: &str| lower.contains(needle);
    let detail: String = text.trim().chars().take(200).collect();

    let (token, permanent): (&str, bool) = if http_status == Some(401)
        || http_status == Some(403)
        || has("api_key_invalid")
        || has("api key not valid")
        || has("permission_denied")
        || has("unauthenticated")
    {
        ("auth", true)
    } else if http_status == Some(429)
        || has("resource_exhausted")
        || has("quota")
        || has("billing")
        || has("rate limit")
        || has("insufficient")
    {
        ("quota", true)
    } else if http_status == Some(404)
        || has("not_found")
        || has("is not found")
        || has("not supported")
    {
        ("model", true)
    } else if http_status == Some(400) || has("invalid_argument") {
        ("bad_request", true)
    } else {
        (fallback_token, false)
    };

    let reason = if detail.is_empty() {
        format!("gemini_{token}")
    } else {
        format!("gemini_{token}: {detail}")
    };
    LiveFailure { reason, permanent }
}

pub fn realtime_audio_message(pcm16: &[i16]) -> Value {
    let mut bytes = Vec::with_capacity(pcm16.len() * 2);
    for s in pcm16 { bytes.extend_from_slice(&s.to_le_bytes()); }
    json!({ "realtimeInput": { "audio": {
        "mimeType": "audio/pcm;rate=16000",
        "data": base64::engine::general_purpose::STANDARD.encode(bytes)
    }}})
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    pub setup_complete: Option<Value>,
    pub server_content: Option<ServerContent>,
    pub go_away: Option<Value>,
    pub session_resumption_update: Option<SessionResumptionUpdate>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerContent {
    pub model_turn: Option<ModelTurn>,
    pub turn_complete: Option<bool>,
    pub interrupted: Option<bool>,
    pub input_transcription: Option<Transcription>,
    pub output_transcription: Option<Transcription>,
}
#[derive(Debug, Deserialize)]
pub struct ModelTurn { pub parts: Vec<Part> }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part { pub inline_data: Option<InlineData> }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineData { pub mime_type: String, pub data: String }
#[derive(Debug, Deserialize)]
pub struct Transcription { pub text: String }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumptionUpdate { pub new_handle: Option<String>, pub resumable: Option<bool> }

pub fn parse_server_message(payload: &[u8]) -> Option<ServerMessage> {
    match serde_json::from_slice(payload) {
        Ok(msg) => Some(msg),
        Err(e) => {
            tracing::warn!("unparseable live api frame: {e}");
            None
        }
    }
}

/// Concatenate all PCM16 audio in a server content frame (24kHz mono LE).
pub fn extract_audio(sc: &ServerContent) -> Vec<i16> {
    let mut out = Vec::new();
    if let Some(turn) = &sc.model_turn {
        for p in &turn.parts {
            if let Some(d) = &p.inline_data {
                if d.mime_type.starts_with("audio/pcm") {
                    if let Ok(mut bytes) = base64::engine::general_purpose::STANDARD.decode(&d.data) {
                        if bytes.len() % 2 != 0 {
                            tracing::warn!("odd pcm payload length {}, dropping trailing byte", bytes.len());
                            bytes.pop();
                        }
                        out.extend(bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])));
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classify_live_failure_buckets() {
        // Auth: HTTP 403 or message markers → permanent.
        let f = classify_live_failure(Some(403), "PERMISSION_DENIED", "connect");
        assert!(f.permanent && f.reason.starts_with("gemini_auth"));
        let f = classify_live_failure(None, "API key not valid", "closed");
        assert!(f.permanent && f.reason.starts_with("gemini_auth"));

        // Quota / balance / rate limit → permanent (the user's case).
        let f = classify_live_failure(Some(429), "", "connect");
        assert!(f.permanent && f.reason.starts_with("gemini_quota"));
        let f = classify_live_failure(None, "RESOURCE_EXHAUSTED: quota", "closed");
        assert!(f.permanent && f.reason.starts_with("gemini_quota"));

        // Model not found → permanent.
        let f = classify_live_failure(Some(404), "model not found", "connect");
        assert!(f.permanent && f.reason.starts_with("gemini_model"));

        // Unknown / network → transient, uses the fallback token.
        let f = classify_live_failure(None, "connect: io error", "connect");
        assert!(!f.permanent && f.reason.starts_with("gemini_connect"));
        let f = classify_live_failure(None, "1011 internal", "closed");
        assert!(!f.permanent && f.reason.starts_with("gemini_closed"));

        // Detail is carried (truncated) for diagnosis.
        let f = classify_live_failure(Some(429), "billing disabled for project", "connect");
        assert!(f.reason.contains("billing disabled"));
    }

    #[test]
    fn setup_message_shape() {
        let v = setup_message("ru", false, None);
        assert_eq!(v["setup"]["model"], "models/gemini-3.5-live-translate-preview");
        let gc = &v["setup"]["generationConfig"];
        assert_eq!(gc["responseModalities"][0], "AUDIO");
        assert_eq!(gc["translationConfig"]["targetLanguageCode"], "ru");
        assert_eq!(gc["translationConfig"]["echoTargetLanguage"], false);
        // Transcription configs are TOP-LEVEL setup fields (SDK wire shape) —
        // inside generationConfig the server rejects the setup.
        assert!(v["setup"].get("inputAudioTranscription").is_some());
        assert!(v["setup"].get("outputAudioTranscription").is_some());
        assert!(gc.get("inputAudioTranscription").is_none());
        assert!(v["setup"].get("sessionResumption").is_some()); // enabled even without handle
    }
    #[test]
    fn setup_message_with_resume_handle() {
        let v = setup_message("en", true, Some("h-123"));
        assert_eq!(v["setup"]["sessionResumption"]["handle"], "h-123");
        assert_eq!(v["setup"]["generationConfig"]["translationConfig"]["echoTargetLanguage"], true);
    }
    #[test]
    fn realtime_audio_is_base64_le() {
        let v = realtime_audio_message(&[1i16, -2]);
        assert_eq!(v["realtimeInput"]["audio"]["mimeType"], "audio/pcm;rate=16000");
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(v["realtimeInput"]["audio"]["data"].as_str().unwrap()).unwrap();
        assert_eq!(raw, vec![1, 0, 0xFE, 0xFF]);
    }
    #[test]
    fn parses_server_audio_and_transcripts() {
        let m = parse_server_message(br#"{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AQD+/w=="}}]},"outputTranscription":{"text":"hello"}}}"#).unwrap();
        let sc = m.server_content.unwrap();
        assert_eq!(extract_audio(&sc), vec![1i16, -2]);
        assert_eq!(sc.output_transcription.unwrap().text, "hello");
    }
    #[test]
    fn parses_goaway_and_resumption() {
        let m = parse_server_message(br#"{"goAway":{"timeLeft":"10s"}}"#).unwrap();
        assert!(m.go_away.is_some());
        let m = parse_server_message(br#"{"sessionResumptionUpdate":{"newHandle":"abc","resumable":true}}"#).unwrap();
        assert_eq!(m.session_resumption_update.unwrap().new_handle.as_deref(), Some("abc"));
    }
    #[test]
    fn tolerates_unknown_fields() {
        assert!(parse_server_message(br#"{"usageMetadata":{"x":1},"weird":true}"#).is_some());
    }
    #[test]
    fn extract_audio_skips_invalid_base64() {
        let sc = ServerContent {
            model_turn: Some(ModelTurn {
                parts: vec![Part {
                    inline_data: Some(InlineData {
                        mime_type: "audio/pcm;rate=24000".to_string(),
                        data: "!!!".to_string(),
                    }),
                }],
            }),
            ..Default::default()
        };
        let result = extract_audio(&sc);
        assert_eq!(result, Vec::<i16>::new());
    }
    #[test]
    fn extract_audio_odd_length_drops_trailing_byte() {
        // base64 of 3 bytes [1, 2, 3] -> "AQID"
        let sc = ServerContent {
            model_turn: Some(ModelTurn {
                parts: vec![Part {
                    inline_data: Some(InlineData {
                        mime_type: "audio/pcm;rate=24000".to_string(),
                        data: "AQID".to_string(),
                    }),
                }],
            }),
            ..Default::default()
        };
        let result = extract_audio(&sc);
        // Should decode to [1, 2, 3], drop the 3, then interpret [1, 2] as one i16 sample
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], i16::from_le_bytes([1, 2]));
    }
}
