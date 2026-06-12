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
    json!({ "setup": {
        "model": LIVE_MODEL,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "translationConfig": { "targetLanguageCode": target_lang, "echoTargetLanguage": echo }
        },
        "sessionResumption": resumption
    }})
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
    fn setup_message_shape() {
        let v = setup_message("ru", false, None);
        assert_eq!(v["setup"]["model"], "models/gemini-3.5-live-translate-preview");
        let gc = &v["setup"]["generationConfig"];
        assert_eq!(gc["responseModalities"][0], "AUDIO");
        assert_eq!(gc["translationConfig"]["targetLanguageCode"], "ru");
        assert_eq!(gc["translationConfig"]["echoTargetLanguage"], false);
        assert!(gc.get("inputAudioTranscription").is_some());
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
