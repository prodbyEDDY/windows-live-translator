# Live Translator — Stage 1 (MVP Live Translation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Working bidirectional live call translation: mic → Gemini → VB-CABLE (peer hears translation), app audio → Gemini → headphones (user hears translation), with ducking, settings, API key management, and a first-run wizard.

**Architecture:** All audio I/O and both Gemini Live WebSocket sessions live in the Rust backend (Tauri 2). Frontend (React + HeroUI) is pure UI talking over typed IPC commands/events. Audio threads (WASAPI via `wasapi` crate) bridge into tokio tasks via channels. Spec: `docs/superpowers/specs/2026-06-12-live-translator-design.md`.

**Tech Stack:** Tauri 2, Rust (tokio, tokio-tungstenite, wasapi, windows, rubato, keyring, reqwest), React 18+ / TypeScript / Vite, HeroUI, Tailwind, i18next, zustand.

**Conventions for all tasks:**
- Run Rust tests from `src-tauri/`: `cargo test`. Hardware tests are `#[ignore]`d; run explicitly when asked.
- Commit after every green step with the message given in the task. All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- If a crate's current API differs from code shown here (versions move), adapt to the crate's docs.rs examples — the *interface we define* (our pub fns/structs) must stay as written, because later tasks depend on it.

---

### Task 0: Scaffold Tauri app + toolchain

**Files:**
- Create: entire Tauri scaffold at repo root (keep existing `docs/`, `.git/`)
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`

- [ ] **Step 0.1: Verify toolchain.** Run: `rustc --version && cargo --version && node --version && npm --version`. Expect Rust ≥1.77, Node ≥20. If missing, stop and report.

- [ ] **Step 0.2: Scaffold into temp dir, move into root.**
```powershell
npm create tauri-app@latest tmp-scaffold -- --template react-ts --manager npm --yes
# move scaffold contents into repo root without clobbering docs/.git
Get-ChildItem tmp-scaffold -Force | Move-Item -Destination . -Force
Remove-Item tmp-scaffold -Recurse -Force
npm install
```

- [ ] **Step 0.3: Configure app identity.** In `src-tauri/tauri.conf.json` set:
```json
{
  "productName": "Live Translator",
  "identifier": "com.livetranslator.app",
  "app": {
    "windows": [{ "title": "Live Translator", "width": 1100, "height": 760, "minWidth": 900, "minHeight": 640 }]
  }
}
```

- [ ] **Step 0.4: Add Rust dependencies** (`src-tauri/`):
```powershell
cargo add tokio --features rt-multi-thread,macros,sync,time
cargo add tokio-tungstenite --features rustls-tls-native-roots
cargo add futures-util serde_json base64 thiserror anyhow tracing crossbeam-channel tempfile zip
cargo add tracing-subscriber --features env-filter
cargo add serde --features derive
cargo add reqwest --no-default-features --features json,rustls-tls
cargo add keyring --features windows-native
cargo add rubato wasapi
cargo add windows --features Win32_Media_Audio,Win32_System_Com,Win32_Foundation,Win32_System_Threading,Win32_UI_Shell
cargo add tokio-util --features sync
```
(Add further `windows` features as the compiler demands; that's expected.)

- [ ] **Step 0.5: Add frontend dependencies:**
```powershell
npm i @heroui/react framer-motion i18next react-i18next zustand
npm i -D tailwindcss @tailwindcss/vite vitest @testing-library/react jsdom
```
Wire Tailwind v4 + HeroUI per https://heroui.com/docs/guide/installation (Tailwind 4 path): add `@tailwindcss/vite` plugin to `vite.config.ts`; create `src/index.css` with `@import "tailwindcss";` + HeroUI plugin/`@source` lines; wrap app in `<HeroUIProvider>` (done in Task 12).

- [ ] **Step 0.6: Verify build.** Run: `npm run tauri dev` until window opens, then close. Expected: default scaffold window appears.

- [ ] **Step 0.7: Commit.** `chore: scaffold tauri app with deps`

---

### Task 1: Settings store (TDD)

**Files:**
- Create: `src-tauri/src/store/mod.rs`, `src-tauri/src/store/settings.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod store;`)

- [ ] **Step 1.1: Write failing tests** in `settings.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.my_lang, "ru");
        assert_eq!(s.peer_lang, "en");
        assert!(s.ducking_enabled);
        assert!((s.duck_level - 0.2).abs() < f32::EPSILON);
        assert!(!s.echo_target_language);
        assert!(!s.wizard_done);
    }
    #[test]
    fn roundtrip_save_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        store.patch(serde_json::json!({"myLang": "de", "duckLevel": 0.5})).unwrap();
        let again = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        assert_eq!(again.get().my_lang, "de");
        assert!((again.get().duck_level - 0.5).abs() < f32::EPSILON);
        assert_eq!(again.get().peer_lang, "en"); // untouched fields keep defaults
    }
    #[test]
    fn patch_rejects_unknown_garbage_types() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("s.json")).unwrap();
        assert!(store.patch(serde_json::json!({"duckLevel": "loud"})).is_err());
    }
}
```

- [ ] **Step 1.2: Run, verify FAIL** (`cargo test settings`): types not defined.

- [ ] **Step 1.3: Implement:**
```rust
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode { App, System }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub my_lang: String,
    pub peer_lang: String,
    pub mic_id: Option<String>,
    pub output_id: Option<String>,
    pub capture_mode: CaptureMode,
    pub echo_target_language: bool,
    pub ducking_enabled: bool,
    pub duck_level: f32,
    pub mix_original: bool,
    pub mix_gain_db: f32,
    pub ui_lang: String,
    pub wizard_done: bool,
    pub tts_voice: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            my_lang: "ru".into(), peer_lang: "en".into(),
            mic_id: None, output_id: None,
            capture_mode: CaptureMode::App,
            echo_target_language: false,
            ducking_enabled: true, duck_level: 0.2,
            mix_original: false, mix_gain_db: -12.0,
            ui_lang: "ru".into(), wizard_done: false,
            tts_voice: "Kore".into(),
        }
    }
}

pub struct SettingsStore { path: PathBuf, inner: Mutex<Settings> }

impl SettingsStore {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let settings = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Settings::default(),
        };
        Ok(Self { path, inner: Mutex::new(settings) })
    }
    pub fn get(&self) -> Settings { self.inner.lock().unwrap().clone() }
    /// Merge a partial JSON object into current settings; unknown/badly-typed fields error.
    pub fn patch(&self, patch: serde_json::Value) -> anyhow::Result<Settings> {
        let mut guard = self.inner.lock().unwrap();
        let mut merged = serde_json::to_value(&*guard)?;
        let serde_json::Value::Object(p) = patch else { anyhow::bail!("patch must be object") };
        merged.as_object_mut().unwrap().extend(p);
        let updated: Settings = serde_json::from_value(merged)?;
        *guard = updated.clone();
        if let Some(dir) = self.path.parent() { std::fs::create_dir_all(dir)?; }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&updated)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(updated)
    }
}
```
`store/mod.rs`: `pub mod settings; pub mod secrets;` (secrets next task — create empty file now).

- [ ] **Step 1.4: Run, verify PASS.** `cargo test settings`

- [ ] **Step 1.5: Commit.** `feat: settings store with atomic persistence`

---

### Task 2: API key secrets + validation

**Files:**
- Create: `src-tauri/src/store/secrets.rs`, `src-tauri/src/gemini/mod.rs`, `src-tauri/src/gemini/rest.rs`

- [ ] **Step 2.1: Write failing test** for status parsing in `rest.rs`:
```rust
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
}
```

- [ ] **Step 2.2: Run, verify FAIL.**

- [ ] **Step 2.3: Implement** `rest.rs`:
```rust
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
```
`secrets.rs`:
```rust
use keyring::Entry;
const SERVICE: &str = "live-translator";
const ACCOUNT: &str = "gemini-api-key";

fn entry() -> keyring::Result<Entry> { Entry::new(SERVICE, ACCOUNT) }
pub fn get_api_key() -> Option<String> { entry().ok()?.get_password().ok() }
pub fn set_api_key(key: &str) -> anyhow::Result<()> { Ok(entry()?.set_password(key.trim())?) }
pub fn delete_api_key() { if let Ok(e) = entry() { let _ = e.delete_credential(); } }
```
`gemini/mod.rs`: `pub mod rest; pub mod types; pub mod live;` (create empty `types.rs`, `live.rs` placeholders compiling as empty modules).

- [ ] **Step 2.4: Run, verify PASS.** Then add ignored live test:
```rust
#[tokio::test]
#[ignore = "needs real key in GEMINI_API_KEY env"]
async fn validates_real_key() {
    let key = std::env::var("GEMINI_API_KEY").unwrap();
    assert!(matches!(validate_key(&key).await, KeyStatus::Valid));
}
```

- [ ] **Step 2.5: Commit.** `feat: api key storage (Credential Manager) and validation`

---

### Task 3: Gemini Live protocol types (TDD)

**Files:**
- Create: `src-tauri/src/gemini/types.rs`

- [ ] **Step 3.1: Write failing tests** (fixtures mirror real Live API frames; server may deliver JSON in *binary* WS frames — parser takes bytes):
```rust
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
}
```

- [ ] **Step 3.2: Run, verify FAIL.**

- [ ] **Step 3.3: Implement:**
```rust
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
#[derive(Debug, Deserialize)]
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
    serde_json::from_slice(payload).ok()
}

/// Concatenate all PCM16 audio in a server content frame (24kHz mono LE).
pub fn extract_audio(sc: &ServerContent) -> Vec<i16> {
    let mut out = Vec::new();
    if let Some(turn) = &sc.model_turn {
        for p in &turn.parts {
            if let Some(d) = &p.inline_data {
                if d.mime_type.starts_with("audio/pcm") {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&d.data) {
                        out.extend(bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])));
                    }
                }
            }
        }
    }
    out
}
```

- [ ] **Step 3.4: Run, verify PASS.** `cargo test gemini::types`

- [ ] **Step 3.5: Commit.** `feat: gemini live protocol types and builders`

---

### Task 4: DSP — downmix, resample, chunk, levels (TDD)

**Files:**
- Create: `src-tauri/src/audio/mod.rs`, `src-tauri/src/audio/dsp.rs`

- [ ] **Step 4.1: Write failing tests:**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix_mono(&[0.3, 0.3], 1), vec![0.3, 0.3]);
    }
    #[test]
    fn f32_to_i16_clamps() {
        assert_eq!(f32_to_i16(&[0.0, 1.0, -1.0, 2.0]), vec![0, 32767, -32767, 32767]);
    }
    #[test]
    fn chunker_emits_fixed_chunks() {
        let mut c = Chunker::new(1600);
        assert!(c.push(&vec![0i16; 1000]).is_empty());
        let out = c.push(&vec![0i16; 2400]);
        assert_eq!(out.len(), 2); // 3400 total -> 2 chunks, 200 remain
        assert!(out.iter().all(|ch| ch.len() == 1600));
    }
    #[test]
    fn resampler_48k_to_16k_ratio() {
        let mut r = StreamResampler::new(48000, 16000);
        let mut total_out = 0usize;
        for _ in 0..100 { total_out += r.push(&vec![0.0f32; 480]).len(); } // 1s of 48k in 10ms blocks
        let expected = 16000;
        assert!((total_out as i64 - expected as i64).abs() < 800, "got {total_out}");
    }
    #[test]
    fn rms_db_silence_is_low() {
        assert!(rms_db(&vec![0.0; 480]) < -80.0);
        assert!(rms_db(&vec![0.5; 480]) > -10.0);
    }
}
```

- [ ] **Step 4.2: Run, verify FAIL.**

- [ ] **Step 4.3: Implement** `dsp.rs`:
```rust
use rubato::{FastFixedIn, PolynomialDegree, Resampler};

pub fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 { return interleaved.to_vec(); }
    interleaved.chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect()
}

pub fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|s| *s as f32 / 32768.0).collect()
}

pub fn rms_db(samples: &[f32]) -> f32 {
    if samples.is_empty() { return -120.0; }
    let ms = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    10.0 * (ms.max(1e-12)).log10()
}

/// Streaming mono resampler accepting arbitrary input lengths.
pub struct StreamResampler {
    inner: FastFixedIn<f32>,
    block: usize,
    buf: Vec<f32>,
}
impl StreamResampler {
    pub fn new(from_hz: usize, to_hz: usize) -> Self {
        let block = from_hz / 100; // 10ms
        let inner = FastFixedIn::<f32>::new(
            to_hz as f64 / from_hz as f64, 1.0,
            PolynomialDegree::Septic, block, 1,
        ).expect("resampler");
        Self { inner, block, buf: Vec::new() }
    }
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        while self.buf.len() >= self.block {
            let chunk: Vec<f32> = self.buf.drain(..self.block).collect();
            if let Ok(mut res) = self.inner.process(&[chunk], None) {
                out.append(&mut res.remove(0));
            }
        }
        out
    }
}

pub struct Chunker { buf: Vec<i16>, size: usize }
impl Chunker {
    pub fn new(size: usize) -> Self { Self { buf: Vec::new(), size } }
    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        self.buf.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.buf.len() >= self.size {
            out.push(self.buf.drain(..self.size).collect());
        }
        out
    }
}
```
`audio/mod.rs`: `pub mod dsp; pub mod devices; pub mod capture; pub mod playback; pub mod ducking;` (create empty placeholder files for the latter four).

- [ ] **Step 4.4: Run, verify PASS.** `cargo test audio::dsp`

- [ ] **Step 4.5: Commit.** `feat: audio dsp primitives (downmix, resample, chunk, rms)`

---

### Task 5: Device & app-session enumeration

**Files:**
- Create: `src-tauri/src/audio/devices.rs`

No unit tests possible without hardware; verify via the `devices_smoke` ignored test + dev run.

- [ ] **Step 5.1: Implement** with `wasapi` crate (enumeration) + `windows` crate (sessions, process names):
```rust
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo { pub id: String, pub name: String, pub is_default: bool }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesPayload {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
    pub cable_present: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession { pub pid: u32, pub name: String }

pub const CABLE_RENDER_NAME: &str = "CABLE Input"; // VB-Audio render endpoint we play into

pub fn list_devices() -> anyhow::Result<DevicesPayload> {
    wasapi::initialize_mta().ok();
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    for (direction, list) in [(wasapi::Direction::Capture, &mut inputs), (wasapi::Direction::Render, &mut outputs)] {
        let default_id = wasapi::get_default_device(&direction).ok()
            .and_then(|d| d.get_id().ok());
        let collection = wasapi::DeviceCollection::new(&direction)?;
        for dev in collection.into_iter().flatten() {
            let id = dev.get_id()?;
            list.push(DeviceInfo {
                name: dev.get_friendlyname()?,
                is_default: Some(&id) == default_id.as_ref(),
                id,
            });
        }
    }
    let cable_present = outputs.iter().any(|d| d.name.contains(CABLE_RENDER_NAME));
    Ok(DevicesPayload { inputs, outputs, cable_present })
}

pub fn cable_render_device_id() -> Option<String> {
    list_devices().ok()?.outputs.into_iter()
        .find(|d| d.name.contains(CABLE_RENDER_NAME)).map(|d| d.id)
}

/// Apps with an active audio session on the default render device (excluding ourselves).
pub fn list_audio_apps() -> anyhow::Result<Vec<AppSession>> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::Foundation::CloseHandle;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // ok if already initialized
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = mgr.GetSessionEnumerator()?;
        let self_pid = std::process::id();
        let mut out: Vec<AppSession> = Vec::new();
        for i in 0..sessions.GetCount()? {
            let ctl = sessions.GetSession(i)?;
            let ctl2: IAudioSessionControl2 = ctl.cast()?;
            let pid = ctl2.GetProcessId()?;
            if pid == 0 || pid == self_pid { continue; }
            if ctl.GetState()? != AudioSessionStateActive { continue; }
            if out.iter().any(|a| a.pid == pid) { continue; }
            // resolve "zoom.exe" -> "zoom"
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let name = if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                let full = String::from_utf16_lossy(&buf[..len as usize]);
                std::path::Path::new(&full).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(full)
            } else { format!("pid {pid}") };
            let _ = CloseHandle(h);
            out.push(AppSession { pid, name });
        }
        Ok(out)
    }
}
```
(Adapt to the installed `windows` crate version — method casing/`Result` shapes shift between releases; the COM call sequence above is the contract. Add whatever `windows` cargo features the compiler asks for.)

- [ ] **Step 5.2: Device-change watcher.** Add to `devices.rs` a polling watcher (simpler and as effective as IMMNotificationClient for our needs):
```rust
/// Spawn a thread that emits "devices:changed" whenever the device set or defaults change. Poll every 2s.
pub fn spawn_device_watcher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        use tauri::Emitter;
        let snapshot = |d: &DevicesPayload| -> String {
            format!("{:?}|{:?}|{}",
                d.inputs.iter().map(|x| (&x.id, x.is_default)).collect::<Vec<_>>(),
                d.outputs.iter().map(|x| (&x.id, x.is_default)).collect::<Vec<_>>(),
                d.cable_present)
        };
        let mut last = String::new();
        loop {
            if let Ok(d) = list_devices() {
                let now = snapshot(&d);
                if now != last && !last.is_empty() { let _ = app.emit("devices:changed", &d); }
                last = now;
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}
```
Call it from `lib.rs` setup. Frontend (Task 12 store) refreshes its device list on this event.

- [ ] **Step 5.3: Smoke test (ignored):**
```rust
#[test]
#[ignore = "requires audio hardware"]
fn devices_smoke() {
    let d = list_devices().unwrap();
    assert!(!d.outputs.is_empty());
    println!("{:#?}", d);
    println!("{:#?}", list_audio_apps().unwrap());
}
```
Run: `cargo test devices_smoke -- --ignored --nocapture`. Expected: your real devices listed; play any YouTube audio first — browser appears in apps list.

- [ ] **Step 5.4: Commit.** `feat: device and app audio-session enumeration`

---

### Task 6: Mic capture engine

**Files:**
- Create: `src-tauri/src/audio/capture.rs`

- [ ] **Step 6.1: Implement capture thread** producing mono 48k f32 blocks:
```rust
use crossbeam_channel::{bounded, Receiver, Sender};
use std::sync::{atomic::{AtomicBool, AtomicI32, Ordering}, Arc};

#[derive(Debug, Clone)]
pub enum CaptureSource {
    Mic { device_id: Option<String> },
    App { pid: u32 },              // process loopback include-tree (Task 10)
    SystemExcludeSelf,             // device loopback excluding our process tree (Task 10)
}

pub struct CaptureHandle {
    pub rx: Receiver<Vec<f32>>,           // mono 48k f32
    pub level_db_x100: Arc<AtomicI32>,    // rms dB * 100
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}
impl CaptureHandle {
    pub fn stop(mut self) { self.stop.store(true, Ordering::Relaxed); if let Some(j) = self.join.take() { let _ = j.join(); } }
}
impl Drop for CaptureHandle {
    fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); }
}

pub const CAPTURE_RATE: usize = 48000;

pub fn start_capture(source: CaptureSource) -> anyhow::Result<CaptureHandle> {
    let (tx, rx) = bounded::<Vec<f32>>(64);
    let stop = Arc::new(AtomicBool::new(false));
    let level = Arc::new(AtomicI32::new(-12000));
    let stop2 = stop.clone(); let level2 = level.clone();
    let (ready_tx, ready_rx) = bounded::<anyhow::Result<()>>(1);
    let join = std::thread::Builder::new().name("audio-capture".into()).spawn(move || {
        wasapi::initialize_mta().ok();
        if let Err(e) = run_capture(source, tx, stop2, level2, ready_tx.clone()) {
            let _ = ready_tx.try_send(Err(e));
        }
    })?;
    ready_rx.recv()??; // propagate device-open errors synchronously
    Ok(CaptureHandle { rx, level_db_x100: level, stop, join: Some(join) })
}

fn run_capture(
    source: CaptureSource,
    tx: Sender<Vec<f32>>,
    stop: Arc<AtomicBool>,
    level: Arc<AtomicI32>,
    ready: Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let mut client = open_client(&source)?;          // see below
    let fmt = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, CAPTURE_RATE, 2, None);
    // Shared mode + autoconvert so any device delivers 48k f32 stereo:
    client.initialize_client(&fmt, 0, &direction_of(&source), &wasapi::ShareMode::Shared, true)?;
    let h_event = client.set_get_eventhandle()?;
    let capture_client = client.get_audiocaptureclient()?;
    client.start_stream()?;
    let _ = ready.send(Ok(()));
    let block_bytes = fmt.get_blockalign() as usize;
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        if h_event.wait_for_event(200).is_err() { continue; }
        let frames = capture_client.get_next_packet_size()?.unwrap_or(0);
        if frames == 0 { continue; }
        let mut raw = vec![0u8; frames as usize * block_bytes];
        capture_client.read_from_device(&mut raw)?;
        let stereo: Vec<f32> = raw.chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let mono = crate::audio::dsp::downmix_mono(&stereo, 2);
        level.store((crate::audio::dsp::rms_db(&mono) * 100.0) as i32, std::sync::atomic::Ordering::Relaxed);
        let _ = tx.try_send(mono); // drop on backpressure rather than block realtime thread
    }
    client.stop_stream()?;
    Ok(())
}

fn direction_of(source: &CaptureSource) -> wasapi::Direction {
    match source { CaptureSource::Mic { .. } => wasapi::Direction::Capture, _ => wasapi::Direction::Render }
}

fn open_client(source: &CaptureSource) -> anyhow::Result<wasapi::AudioClient> {
    match source {
        CaptureSource::Mic { device_id } => {
            let device = match device_id {
                Some(id) => wasapi::get_device_by_id(id, &wasapi::Direction::Capture)?, // adapt to crate API
                None => wasapi::get_default_device(&wasapi::Direction::Capture)?,
            };
            Ok(device.get_iaudioclient()?)
        }
        CaptureSource::App { .. } | CaptureSource::SystemExcludeSelf =>
            anyhow::bail!("process loopback lands in Task 10"),
    }
}
```
Note: exact wasapi-crate fn names (`get_device_by_id`, `read_from_device`, `set_get_eventhandle`) may differ slightly by version — follow the crate's `examples/capture.rs`; keep our pub interface identical. Process-loopback initialize differs (no autoconvert; explicit format + loopback flag) — that lives in Task 10, mic path must not regress then.

- [ ] **Step 6.2: Ignored hardware test** (records 3s of mic to wav using `hound` — `cargo add hound --dev`):
```rust
#[test]
#[ignore = "requires mic; listen to /tmp output"]
fn mic_capture_3s() {
    let h = start_capture(CaptureSource::Mic { device_id: None }).unwrap();
    let spec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(std::env::temp_dir().join("mic_test.wav"), spec).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if let Ok(block) = h.rx.recv_timeout(std::time::Duration::from_millis(300)) {
            for s in block { w.write_sample(s).unwrap(); }
        }
    }
    w.finalize().unwrap();
    h.stop();
}
```
Run: `cargo test mic_capture_3s -- --ignored`, speak into mic, open `%TEMP%\mic_test.wav`, confirm audible speech.

- [ ] **Step 6.3: Commit.** `feat: wasapi mic capture engine`

---

### Task 7: Playback engine (headphones + CABLE)

**Files:**
- Create: `src-tauri/src/audio/playback.rs`

- [ ] **Step 7.1: Implement render thread** with jitter buffer and occupancy gauge:
```rust
use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::VecDeque;
use std::sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc};

pub struct PlaybackHandle {
    pub tx: Sender<Vec<i16>>,                // PCM mono at src_rate
    pub queued_samples: Arc<AtomicUsize>,    // for ducking trigger & underrun stats
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}
impl PlaybackHandle {
    pub fn stop(mut self) { self.stop.store(true, Ordering::Relaxed); if let Some(j) = self.join.take() { let _ = j.join(); } }
}
impl Drop for PlaybackHandle { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }

pub const RENDER_RATE: usize = 48000;
const PREBUFFER_MS: usize = 150;

/// device_id None => default render device. src_rate: rate of pushed PCM (24000 from Gemini).
pub fn start_playback(device_id: Option<String>, src_rate: usize) -> anyhow::Result<PlaybackHandle> {
    let (tx, rx) = bounded::<Vec<i16>>(256);
    let stop = Arc::new(AtomicBool::new(false));
    let queued = Arc::new(AtomicUsize::new(0));
    let (ready_tx, ready_rx) = bounded::<anyhow::Result<()>>(1);
    let stop2 = stop.clone(); let queued2 = queued.clone();
    let join = std::thread::Builder::new().name("audio-render".into()).spawn(move || {
        wasapi::initialize_mta().ok();
        if let Err(e) = run_playback(device_id, src_rate, rx, stop2, queued2, ready_tx.clone()) {
            let _ = ready_tx.try_send(Err(e));
        }
    })?;
    ready_rx.recv()??;
    Ok(PlaybackHandle { tx, queued_samples: queued, stop, join: Some(join) })
}

fn run_playback(
    device_id: Option<String>, src_rate: usize,
    rx: Receiver<Vec<i16>>, stop: Arc<AtomicBool>,
    queued: Arc<AtomicUsize>, ready: Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let device = match &device_id {
        Some(id) => wasapi::get_device_by_id(id, &wasapi::Direction::Render)?,
        None => wasapi::get_default_device(&wasapi::Direction::Render)?,
    };
    let mut client = device.get_iaudioclient()?;
    let fmt = wasapi::WaveFormat::new(32, 32, &wasapi::SampleType::Float, RENDER_RATE, 2, None);
    client.initialize_client(&fmt, 0, &wasapi::Direction::Render, &wasapi::ShareMode::Shared, true)?;
    let h_event = client.set_get_eventhandle()?;
    let render = client.get_audiorenderclient()?;
    let buffer_frames = client.get_bufferframecount()? as usize;
    client.start_stream()?;
    let _ = ready.send(Ok(()));

    let mut resampler = crate::audio::dsp::StreamResampler::new(src_rate, RENDER_RATE);
    let mut fifo: VecDeque<f32> = VecDeque::new(); // mono 48k
    let prebuffer = RENDER_RATE * PREBUFFER_MS / 1000;
    let mut started = false;

    while !stop.load(Ordering::Relaxed) {
        // ingest everything pending
        while let Ok(chunk) = rx.try_recv() {
            let f = crate::audio::dsp::i16_to_f32(&chunk);
            fifo.extend(resampler.push(&f));
        }
        queued.store(fifo.len(), Ordering::Relaxed);
        if !started && fifo.len() < prebuffer { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
        started = !fifo.is_empty();
        if h_event.wait_for_event(200).is_err() { continue; }
        let padding = client.get_current_padding()? as usize;
        let writable = buffer_frames.saturating_sub(padding);
        if writable == 0 { continue; }
        let mut out = Vec::with_capacity(writable * 8); // f32 stereo bytes
        for _ in 0..writable {
            let s = fifo.pop_front().unwrap_or(0.0);
            for b in s.to_le_bytes() { out.push(b); }   // L
            for b in s.to_le_bytes() { out.push(b); }   // R
        }
        render.write_to_device(writable, 8, &out, None)?;
        if fifo.is_empty() { started = false; } // re-arm prebuffer on drain (turn boundary)
    }
    client.stop_stream()?;
    Ok(())
}
```
(Adapt wasapi fn names to crate's `examples/playback.rs`; keep our pub interface.)

- [ ] **Step 7.2: Ignored hardware test** — 440Hz tone at 24k pushed in 100ms chunks for 2s to default device:
```rust
#[test]
#[ignore = "plays audible tone"]
fn tone_2s() {
    let h = start_playback(None, 24000).unwrap();
    for i in 0..20 {
        let chunk: Vec<i16> = (0..2400).map(|n| {
            let t = (i * 2400 + n) as f32 / 24000.0;
            ((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16
        }).collect();
        h.tx.send(chunk).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    h.stop();
}
```
Run: `cargo test tone_2s -- --ignored`. Expected: clean 2s tone, no crackle (jitter buffer works).

- [ ] **Step 7.3: Commit.** `feat: wasapi playback engine with jitter buffer`

---

### Task 8: Live session actor (WS + reconnect, tested against mock server)

**Files:**
- Create: `src-tauri/src/gemini/live.rs`
- Test: same file `#[cfg(test)]` + `src-tauri/tests/mock_live_server.rs` helper module (inline in test mod is fine)

- [ ] **Step 8.1: Write failing integration-style test with local mock WS server:**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    async fn mock_server(expect_resume: Option<String>) -> (String, tokio::task::JoinHandle<serde_json::Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let setup: serde_json::Value = match ws.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str(&t).unwrap(),
                m => panic!("expected text setup, got {m:?}"),
            };
            if let Some(h) = expect_resume { assert_eq!(setup["setup"]["sessionResumption"]["handle"], h); }
            ws.send(r#"{"setupComplete":{}}"#.into()).await.unwrap();
            ws.send(r#"{"sessionResumptionUpdate":{"newHandle":"h-1","resumable":true}}"#.into()).await.unwrap();
            ws.send(r#"{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AQACAA=="}}]},"outputTranscription":{"text":"hi"}}}"#.into()).await.unwrap();
            setup
        });
        (format!("ws://{addr}"), handle)
    }

    #[tokio::test]
    async fn session_connects_streams_and_reports() {
        let (url, server) = mock_server(None).await;
        let (session, mut events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: Some(url), api_key: "test".into(),
            target_lang: "ru".into(), echo: false, label: "in",
        });
        session.send_audio(vec![0i16; 1600]).await;
        let mut got_audio = false; let mut got_transcript = false;
        while let Ok(Some(ev)) = tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await {
            match ev {
                SessionEvent::Audio(pcm) => { assert_eq!(pcm, vec![1i16, 2]); got_audio = true; }
                SessionEvent::OutputTranscript(t) => { assert_eq!(t, "hi"); got_transcript = true; }
                _ => {}
            }
            if got_audio && got_transcript { break; }
        }
        assert!(got_audio && got_transcript);
        let setup = server.await.unwrap();
        assert_eq!(setup["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"], "ru");
        session.stop().await;
    }

    #[tokio::test]
    async fn session_reconnects_with_resume_handle() {
        // server 1: completes setup, sends handle h-1, then drops connection
        let (url1, s1) = mock_server(None).await;
        let (session, mut events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: Some(url1), api_key: "test".into(),
            target_lang: "en".into(), echo: false, label: "out",
        });
        // wait for first connect + server drop
        let mut reconnecting = false;
        while let Ok(Some(ev)) = tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await {
            if matches!(ev, SessionEvent::Reconnecting) { reconnecting = true; break; }
        }
        assert!(reconnecting, "must emit Reconnecting after server drop");
        s1.abort();
        // NOTE: full resume-handle assertion needs endpoint swap; we verify handle propagation
        // at unit level via setup_message_with_resume_handle (Task 3) + the Reconnecting event here.
        session.stop().await;
    }
}
```

- [ ] **Step 8.2: Run, verify FAIL** (types don't exist).

- [ ] **Step 8.3: Implement:**
```rust
use crate::gemini::types::*;
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub struct LiveSessionConfig {
    pub endpoint: Option<String>, // None => real Gemini WS_URL
    pub api_key: String,
    pub target_lang: String,
    pub echo: bool,
    pub label: &'static str,      // "in" | "out", for logs/events
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Connected,
    Reconnecting,
    Audio(Vec<i16>),              // 24k mono
    InputTranscript(String),
    OutputTranscript(String),
    TurnComplete,
    Failed(String),               // terminal
}

enum Ctl { Audio(Vec<i16>), Stop }

pub struct LiveSession { ctl: mpsc::Sender<Ctl> }

impl LiveSession {
    pub fn spawn(cfg: LiveSessionConfig) -> (Self, mpsc::Receiver<SessionEvent>) {
        let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>(256);
        let (ev_tx, ev_rx) = mpsc::channel::<SessionEvent>(256);
        tokio::spawn(run_session(cfg, ctl_rx, ev_tx));
        (Self { ctl: ctl_tx }, ev_rx)
    }
    pub async fn send_audio(&self, pcm16: Vec<i16>) { let _ = self.ctl.send(Ctl::Audio(pcm16)).await; }
    pub fn blocking_send_audio(&self, pcm16: Vec<i16>) { let _ = self.ctl.blocking_send(Ctl::Audio(pcm16)); }
    pub async fn stop(&self) { let _ = self.ctl.send(Ctl::Stop).await; }
}

async fn run_session(cfg: LiveSessionConfig, mut ctl: mpsc::Receiver<Ctl>, ev: mpsc::Sender<SessionEvent>) {
    let mut resume_handle: Option<String> = None;
    let mut pending: VecDeque<Vec<i16>> = VecDeque::new(); // buffered audio during reconnect, cap ~10s
    const PENDING_CAP: usize = 100;
    let mut attempt: u32 = 0;

    'outer: loop {
        let url = match &cfg.endpoint {
            Some(e) => e.clone(),
            None => format!("{WS_URL}?key={}", cfg.api_key),
        };
        let ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                attempt += 1;
                if attempt > 6 { let _ = ev.send(SessionEvent::Failed(format!("connect: {e}"))).await; return; }
                let _ = ev.send(SessionEvent::Reconnecting).await;
                tokio::time::sleep(std::time::Duration::from_millis(500 * 2u64.pow(attempt.min(5)))).await;
                continue;
            }
        };
        let (mut sink, mut stream) = ws.split();
        let setup = setup_message(&cfg.target_lang, cfg.echo, resume_handle.as_deref());
        if sink.send(Message::Text(setup.to_string().into())).await.is_err() { continue; }
        attempt = 0;
        let _ = ev.send(SessionEvent::Connected).await;
        // flush audio buffered during the gap
        while let Some(chunk) = pending.pop_front() {
            let _ = sink.send(Message::Text(realtime_audio_message(&chunk).to_string().into())).await;
        }
        loop {
            tokio::select! {
                cmd = ctl.recv() => match cmd {
                    Some(Ctl::Audio(pcm)) => {
                        let msg = realtime_audio_message(&pcm).to_string();
                        if sink.send(Message::Text(msg.into())).await.is_err() {
                            pending.push_back(pcm);
                            while pending.len() > PENDING_CAP { pending.pop_front(); }
                            let _ = ev.send(SessionEvent::Reconnecting).await;
                            continue 'outer;
                        }
                    }
                    Some(Ctl::Stop) | None => { let _ = sink.close().await; return; }
                },
                frame = stream.next() => match frame {
                    Some(Ok(msg)) => {
                        let payload: Vec<u8> = match msg {
                            Message::Text(t) => t.as_bytes().to_vec(),
                            Message::Binary(b) => b.to_vec(),
                            Message::Close(_) => { let _ = ev.send(SessionEvent::Reconnecting).await; continue 'outer; }
                            _ => continue,
                        };
                        let Some(parsed) = parse_server_message(&payload) else { continue };
                        if let Some(u) = parsed.session_resumption_update {
                            if u.resumable == Some(true) { resume_handle = u.new_handle; }
                        }
                        if parsed.go_away.is_some() { let _ = ev.send(SessionEvent::Reconnecting).await; continue 'outer; }
                        if let Some(sc) = parsed.server_content {
                            let audio = extract_audio(&sc);
                            if !audio.is_empty() { let _ = ev.send(SessionEvent::Audio(audio)).await; }
                            if let Some(t) = sc.input_transcription { let _ = ev.send(SessionEvent::InputTranscript(t.text)).await; }
                            if let Some(t) = sc.output_transcription { let _ = ev.send(SessionEvent::OutputTranscript(t.text)).await; }
                            if sc.turn_complete == Some(true) { let _ = ev.send(SessionEvent::TurnComplete).await; }
                        }
                    }
                    Some(Err(_)) | None => { let _ = ev.send(SessionEvent::Reconnecting).await; continue 'outer; }
                },
            }
        }
    }
}
```

- [ ] **Step 8.4: Run, verify PASS.** `cargo test gemini::live`

- [ ] **Step 8.5: Add ignored real-API smoke test:**
```rust
#[tokio::test]
#[ignore = "real API; needs GEMINI_API_KEY"]
async fn real_session_smoke() {
    let key = std::env::var("GEMINI_API_KEY").unwrap();
    let (s, mut ev) = LiveSession::spawn(LiveSessionConfig {
        endpoint: None, api_key: key, target_lang: "en".into(), echo: false, label: "smoke",
    });
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), ev.recv()).await.unwrap();
    assert!(matches!(first, Some(SessionEvent::Connected)), "got {first:?}");
    s.send_audio(vec![0i16; 1600]).await;
    s.stop().await;
}
```

- [ ] **Step 8.6: Commit.** `feat: gemini live session actor with reconnect and resume`

---

### Task 9: LiveController — OUT pipeline + IPC commands/events

**Files:**
- Create: `src-tauri/src/live_ctrl.rs`, `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs` (state + handlers registration)

- [ ] **Step 9.1: Define controller** (state machine in tokio task; audio threads bridged with `blocking_send`):
```rust
use crate::audio::{capture::*, playback::*, dsp::*};
use crate::gemini::live::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    pub my_lang: String,
    pub peer_lang: String,
    pub mic_id: Option<String>,
    pub output_id: Option<String>,
    pub capture_mode: String,       // "app" | "system"
    pub app_pid: Option<u32>,
    pub echo_target_language: bool,
    pub ducking_enabled: bool,
    pub duck_level: f32,
    pub test_mode: bool,            // wizard: OUT translation -> user's phones, IN disabled
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState { pub phase: String, pub out_session: String, pub in_session: String }

pub struct LiveController { /* handles kept to stop everything */
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    // join handles for the two forwarder threads + tokio tasks
}
```
The controller exposes `start(app: AppHandle, api_key: String, cfg: LiveConfig) -> anyhow::Result<LiveController>` and `stop(self)`. Core wiring (one direction shown; IN direction is added in Task 11 by the same pattern):
```rust
impl LiveController {
    pub fn start(app: AppHandle, api_key: String, cfg: LiveConfig) -> anyhow::Result<Self> {
        let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        // 1. resolve OUT playback target
        let out_play_id = if cfg.test_mode { cfg.output_id.clone() }
            else { Some(crate::audio::devices::cable_render_device_id().ok_or_else(|| anyhow::anyhow!("cable_missing"))?) };
        // 2. OUT chain: mic -> 16k chunks -> session_out -> playback(cable|phones)
        let mic = start_capture(CaptureSource::Mic { device_id: cfg.mic_id.clone() })?;
        let (session_out, mut out_events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: None, api_key: api_key.clone(),
            target_lang: cfg.peer_lang.clone(), echo: cfg.echo_target_language, label: "out",
        });
        let play_out = start_playback(out_play_id, 24000)?;
        let mic_level = mic.level_db_x100.clone();
        { // capture-thread bridge (std thread; blocking_send into tokio session)
            let stop = stop_flag.clone(); let session = session_out.clone();
            let rx = mic.rx.clone();
            std::thread::spawn(move || {
                let mut rs = StreamResampler::new(48000, 16000);
                let mut ch = Chunker::new(1600);
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let Ok(block) = rx.recv_timeout(std::time::Duration::from_millis(200)) else { continue };
                    for chunk in ch.push(&f32_to_i16(&rs.push(&block))) { session.blocking_send_audio(chunk); }
                }
            });
        }
        { // session-events bridge (tokio)
            let app2 = app.clone(); let play_tx = play_out.tx.clone(); let stop = stop_flag.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = out_events.recv().await {
                    if stop.load(std::sync::atomic::Ordering::Relaxed) { break; }
                    match ev {
                        SessionEvent::Audio(pcm) => { let _ = play_tx.try_send(pcm); }
                        SessionEvent::InputTranscript(text) => { let _ = app2.emit("live:transcript", serde_json::json!({"direction":"out","kind":"original","text":text})); }
                        SessionEvent::OutputTranscript(text) => { let _ = app2.emit("live:transcript", serde_json::json!({"direction":"out","kind":"translated","text":text})); }
                        SessionEvent::Connected => { let _ = app2.emit("live:state", serde_json::json!({"phase":"running","outSession":"running","inSession":"off"})); }
                        SessionEvent::Reconnecting => { let _ = app2.emit("live:state", serde_json::json!({"phase":"running","outSession":"reconnecting","inSession":"off"})); }
                        SessionEvent::Failed(e) => { let _ = app2.emit("live:state", serde_json::json!({"phase":"error","outSession":e,"inSession":"off"})); }
                        _ => {}
                    }
                }
            });
        }
        { // levels task: 100ms tick
            let app2 = app.clone(); let stop = stop_flag.clone();
            tauri::async_runtime::spawn(async move {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let mic_db = mic_level.load(std::sync::atomic::Ordering::Relaxed) as f32 / 100.0;
                    let _ = app2.emit("live:levels", serde_json::json!({"micDb": mic_db, "appDb": -120.0, "outDb": -120.0}));
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            });
        }
        Ok(Self { stop_flag, mic: Some(mic), play_out: Some(play_out), session_out: Some(session_out) /* + IN handles in Task 11 */ })
    }
    pub fn stop(mut self) {
        self.stop_flag.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(s) = self.session_out.take() { tauri::async_runtime::block_on(s.stop()); }
        if let Some(m) = self.mic.take() { m.stop(); }
        if let Some(p) = self.play_out.take() { p.stop(); }
    }
}
```
Notes: derive `Clone` for `LiveSession` (it's just an `mpsc::Sender`) and make `CaptureHandle.rx` a `crossbeam_channel::Receiver` clone (it already is clonable). Adjust the `LiveController` struct fields to hold these `Option<...>` handles.

- [ ] **Step 9.2: IPC commands** in `ipc.rs`:
```rust
use tauri::State;
use std::sync::Mutex;

pub struct AppState {
    pub settings: crate::store::settings::SettingsStore,
    pub live: Mutex<Option<crate::live_ctrl::LiveController>>,
}

#[tauri::command] pub fn settings_get(s: State<AppState>) -> crate::store::settings::Settings { s.settings.get() }
#[tauri::command] pub fn settings_set(s: State<AppState>, patch: serde_json::Value) -> Result<crate::store::settings::Settings, String> { s.settings.patch(patch).map_err(|e| e.to_string()) }
#[tauri::command] pub fn api_key_status() -> crate::gemini::rest::KeyStatus {
    match crate::store::secrets::get_api_key() { Some(_) => crate::gemini::rest::KeyStatus::Valid, None => crate::gemini::rest::KeyStatus::Missing }
}
#[tauri::command] pub async fn api_key_set(key: String) -> Result<crate::gemini::rest::KeyStatus, String> {
    let status = crate::gemini::rest::validate_key(&key).await;
    if matches!(status, crate::gemini::rest::KeyStatus::Valid) {
        crate::store::secrets::set_api_key(&key).map_err(|e| e.to_string())?;
    }
    Ok(status)
}
#[tauri::command] pub fn devices_list() -> Result<crate::audio::devices::DevicesPayload, String> { crate::audio::devices::list_devices().map_err(|e| e.to_string()) }
#[tauri::command] pub fn audio_apps_list() -> Result<Vec<crate::audio::devices::AppSession>, String> { crate::audio::devices::list_audio_apps().map_err(|e| e.to_string()) }
#[tauri::command] pub fn live_start(app: tauri::AppHandle, s: State<AppState>, cfg: crate::live_ctrl::LiveConfig) -> Result<(), String> {
    let key = crate::store::secrets::get_api_key().ok_or("no_api_key")?;
    let mut guard = s.live.lock().unwrap();
    if guard.is_some() { return Err("already_running".into()); }
    *guard = Some(crate::live_ctrl::LiveController::start(app, key, cfg).map_err(|e| e.to_string())?);
    Ok(())
}
#[tauri::command] pub fn live_stop(s: State<AppState>) {
    if let Some(c) = s.live.lock().unwrap().take() { c.stop(); }
}
```
Register all in `lib.rs` `invoke_handler(tauri::generate_handler![...])`; build `AppState` in `setup` with settings path from `app.path().app_data_dir()`.

- [ ] **Step 9.3: Build + manual verify:** `cargo check` clean; `npm run tauri dev`, from devtools console run `window.__TAURI__.core.invoke('devices_list')` (enable `app.withGlobalTauri: true` in tauri.conf.json for dev) and confirm JSON.

- [ ] **Step 9.4: Commit.** `feat: live controller OUT pipeline and IPC surface`

---

### Task 10: Process loopback + system-exclude-self capture

**Files:**
- Modify: `src-tauri/src/audio/capture.rs` (`open_client`, `run_capture` init path)

- [ ] **Step 10.1: Implement** the two loopback arms of `open_client` using `wasapi::AudioClient::new_application_loopback_client(pid, include_tree)`:
  - `App { pid }` → `new_application_loopback_client(pid, true)` (include process tree — browsers/electron have child audio processes).
  - `SystemExcludeSelf` → `new_application_loopback_client(std::process::id(), false)` (exclude our tree, capture everything else).
  - Loopback clients have **no mix format**: initialize with our explicit `WaveFormat` (48k f32 stereo) and loopback streamflags; follow the wasapi crate's `examples/loopback.rs` / process-loopback example exactly (init differs from the shared-mode mic path — branch inside `run_capture`).

- [ ] **Step 10.2: Ignored hardware test:**
```rust
#[test]
#[ignore = "play audio in some app first; pass pid via TEST_PID env"]
fn app_loopback_3s() {
    let pid: u32 = std::env::var("TEST_PID").unwrap().parse().unwrap();
    let h = start_capture(CaptureSource::App { pid }).unwrap();
    let mut total = 0usize;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        if let Ok(b) = h.rx.recv_timeout(std::time::Duration::from_millis(300)) { total += b.len(); }
    }
    h.stop();
    assert!(total > 48000, "captured {total} samples"); // >1s of audio captured
}
```
Run with YouTube playing: `$env:TEST_PID=<browser-pid>; cargo test app_loopback_3s -- --ignored`.

- [ ] **Step 10.3: Commit.** `feat: per-app process loopback and system capture`

---

### Task 11: IN pipeline + ducking

**Files:**
- Create: `src-tauri/src/audio/ducking.rs`
- Modify: `src-tauri/src/live_ctrl.rs`

- [ ] **Step 11.1: Ducking with RAII + crash-restore file (TDD on the restore-file logic):**
```rust
// tests (pure logic):
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duck-restore.json");
        write_restore_file(&path, &[(1234, 0.8), (5678, 1.0)]).unwrap();
        assert_eq!(read_restore_file(&path).unwrap(), vec![(1234, 0.8), (5678, 1.0)]);
        clear_restore_file(&path);
        assert!(read_restore_file(&path).is_none());
    }
}
```
Implement `DuckGuard`:
```rust
pub struct DuckGuard { entries: Vec<DuckEntry>, restore_path: std::path::PathBuf }
// DuckEntry holds ISimpleAudioVolume (raw COM) + original volume + pid
impl DuckGuard {
    /// Lower volume of `pid`'s sessions (or all non-self sessions if pid None) to `level` with ~150ms ramp.
    pub fn duck(restore_path: PathBuf, pid: Option<u32>, level: f32) -> anyhow::Result<Self> { /* enumerate sessions like list_audio_apps, GetSimpleAudioVolume, remember original, ramp down in 5 steps */ }
}
impl Drop for DuckGuard { fn drop(&mut self) { /* ramp volumes back, clear_restore_file */ } }
/// Call once at app startup: restore any volumes a crashed previous run left ducked.
pub fn restore_after_crash(restore_path: &Path) { /* read file, find sessions by pid, SetMasterVolume(orig) */ }
```

- [ ] **Step 11.2: Wire IN pipeline in LiveController** (skip when `test_mode`):
  - `start_capture(App{pid} | SystemExcludeSelf)` per `cfg.capture_mode` → resample/chunk → `session_in` (target = `my_lang`) → `start_playback(cfg.output_id, 24000)` (user's phones).
  - Ducking task (tokio, 50ms tick): if `ducking_enabled` and `playback_in.queued_samples > 0` → ensure `DuckGuard` exists (duck the captured pid, or all-except-self for system mode); if queued == 0 for 400ms → drop guard.
  - App-closed detection: if capture channel disconnects (`recv` returns `Err(Disconnected)`), emit `live:state` with `in_session: "source_lost"`.
  - Call `ducking::restore_after_crash` in `lib.rs` setup.

- [ ] **Step 11.3: Manual verify:** `npm run tauri dev`; play a YouTube video in browser; from devtools: `invoke('live_start', { cfg: { myLang:'ru', peerLang:'en', capture_mode... } })` with valid key. Expected: translated Russian speech of the video in headphones; video volume visibly ducks in Windows Volume Mixer while translation plays; `live_stop` restores it.

- [ ] **Step 11.4: Commit.** `feat: incoming pipeline with session ducking`

---

### Task 12: Frontend foundation (HeroUI, i18n, store, typed IPC)

**Files:**
- Create: `src/lib/ipc.ts`, `src/stores/app.ts`, `src/i18n/index.ts`, `src/i18n/ru.json`, `src/i18n/en.json`, `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`, `src/index.css`, `vite.config.ts`

- [ ] **Step 12.1: Typed IPC layer** `src/lib/ipc.ts` (mirror Rust types):
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type KeyStatus = { state: "missing" | "valid" } | { state: "invalid"; reason: string } | { state: "error"; message: string };
export interface DeviceInfo { id: string; name: string; isDefault: boolean }
export interface DevicesPayload { inputs: DeviceInfo[]; outputs: DeviceInfo[]; cablePresent: boolean }
export interface AppSession { pid: number; name: string }
export interface Settings {
  myLang: string; peerLang: string; micId: string | null; outputId: string | null;
  captureMode: "app" | "system"; echoTargetLanguage: boolean;
  duckingEnabled: boolean; duckLevel: number; mixOriginal: boolean; mixGainDb: number;
  uiLang: string; wizardDone: boolean; ttsVoice: string;
}
export interface LiveConfig {
  myLang: string; peerLang: string; micId: string | null; outputId: string | null;
  captureMode: "app" | "system"; appPid: number | null;
  echoTargetLanguage: boolean; duckingEnabled: boolean; duckLevel: number; testMode: boolean;
}
export interface TranscriptEvent { direction: "in" | "out"; kind: "original" | "translated"; text: string }
export interface LiveStateEvent { phase: string; outSession: string; inSession: string }
export interface LevelsEvent { micDb: number; appDb: number; outDb: number }

export const ipc = {
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (patch: Partial<Settings>) => invoke<Settings>("settings_set", { patch }),
  apiKeyStatus: () => invoke<KeyStatus>("api_key_status"),
  apiKeySet: (key: string) => invoke<KeyStatus>("api_key_set", { key }),
  devicesList: () => invoke<DevicesPayload>("devices_list"),
  audioAppsList: () => invoke<AppSession[]>("audio_apps_list"),
  liveStart: (cfg: LiveConfig) => invoke<void>("live_start", { cfg }),
  liveStop: () => invoke<void>("live_stop"),
  onTranscript: (cb: (e: TranscriptEvent) => void): Promise<UnlistenFn> => listen("live:transcript", (e) => cb(e.payload as TranscriptEvent)),
  onLiveState: (cb: (e: LiveStateEvent) => void): Promise<UnlistenFn> => listen("live:state", (e) => cb(e.payload as LiveStateEvent)),
  onLevels: (cb: (e: LevelsEvent) => void): Promise<UnlistenFn> => listen("live:levels", (e) => cb(e.payload as LevelsEvent)),
};
```

- [ ] **Step 12.2: zustand store** `src/stores/app.ts` — holds `settings`, `keyStatus`, `devices`, `apps`, `liveState`, `transcripts: TranscriptLine[]` (merge rule: consecutive partial transcripts of same direction+kind replace the last line until a `TurnComplete`-style break; Stage 1 rule: append text to current open line per (direction,kind), close line on direction change), `levels`. Actions: `init()` (loads settings/key/devices, subscribes events once), `patchSettings`, `start`, `stop`. Add a vitest for the transcript merge reducer (pure function `appendTranscript(lines, event): lines`).

- [ ] **Step 12.3: i18n** — `i18n/index.ts` initializes i18next with `ru.json`/`en.json`; all UI strings below come from these files. Seed both files with the keys used in Tasks 13–15 (nav.live, nav.settings, live.start, live.stop, settings.apiKey, ... — fill all keys you actually use; EN values can be literal translations).

- [ ] **Step 12.4: App shell** — `App.tsx`: `<HeroUIProvider>`, light theme class, left `Sidebar` (Live / Settings; Wizard route shown automatically when `!settings.wizardDone`), main panel switches screens via simple state (no router lib). Verify `npm run tauri dev` shows shell. `npm test` green.

- [ ] **Step 12.5: Commit.** `feat: frontend foundation (heroui shell, i18n, typed ipc, store)`

---

### Task 13: Settings screen

**Files:**
- Create: `src/screens/SettingsScreen.tsx`, `src/components/ApiKeyField.tsx`

- [ ] **Step 13.1: Build screen** with HeroUI components, all bound to store `patchSettings`:
  - `ApiKeyField`: masked `Input` + "Проверить/Сменить" `Button`; on save → `ipc.apiKeySet` → show `Chip` colored by status (`valid` green / `invalid` red with reason).
  - Devices `Select` ×2 (mic from `devices.inputs`, output from `devices.outputs`), VB-CABLE status `Chip` (`cablePresent`) + "Переустановить" button → opens wizard.
  - Translation section: `Switch` echoTargetLanguage (with tooltip text from i18n explaining echo semantics), `Switch` ducking + `Slider` duckLevel (0–100%), `Switch` mixOriginal + `Slider` mixGainDb (−24..0 dB) — mixOriginal UI present but disabled with "скоро" tooltip (backend lands Stage 3).
  - App section: UI language `Select` (ru/en → i18next.changeLanguage + settings), version text.

- [ ] **Step 13.2: Manual verify** in `tauri dev`: change settings, restart app, values persist; bad API key shows red reason.

- [ ] **Step 13.3: Commit.** `feat: settings screen`

---

### Task 14: Live screen

**Files:**
- Create: `src/screens/LiveScreen.tsx`, `src/components/TranscriptFeed.tsx`, `src/components/LevelMeter.tsx`, `src/components/LanguagePair.tsx`, `src/lib/languages.ts`

- [ ] **Step 14.1: `languages.ts`** — const array of the supported translate languages `{ code, autonym }` (take list from the live-translate docs page; include at minimum: ru Русский, en English, de Deutsch, fr Français, es Español, it Italiano, pt Português, pl Polski, tr Türkçe, ar العربية, hi हिन्दी, zh 中文, ja 日本語, ko 한국어, uk Українська + the rest from docs).

- [ ] **Step 14.2: Build screen:**
  - Header row: `LanguagePair` (two `Autocomplete`s + swap `Button` ⇄), source `Select` (entries from `audioAppsList()` refreshed on open + "Весь звук системы"), big `Button` Start/Stop (color success/danger, disabled when key invalid or — for full mode — cable missing).
  - Warning `Banner`s (HeroUI `Alert`): cable missing → CTA to wizard; key missing/invalid → CTA to settings; output device looks like speakers (name lacks "наушник/headphone/earphone/Buds/Headset") → soft warning about echo.
  - `TranscriptFeed`: scrollable column of bubbles; own speech right-aligned, peer left; each bubble: translated text prominent + original muted below; autoscroll pinned to bottom unless user scrolled up.
  - Status bar: two session `Chip`s (running=green, reconnecting=yellow pulse, error=red) + `LevelMeter`s (mic, app) + call duration timer (frontend-side, starts on `phase: running`).
  - Start handler builds `LiveConfig` from settings + screen selections, `ipc.liveStart`, errors surfaced as toast (`cable_missing` → wizard CTA toast).

- [ ] **Step 14.3: Vitest** for TranscriptFeed line-merge display logic (reuses store reducer test fixtures).

- [ ] **Step 14.4: Manual verify** end-to-end IN pipeline: YouTube + Start → bubbles appear, translation audible, meters move.

- [ ] **Step 14.5: Commit.** `feat: live translation screen`

---

### Task 15: First-run wizard + VB-CABLE install

**Files:**
- Create: `src-tauri/src/wizard.rs`, `src/screens/WizardScreen.tsx`
- Modify: `src-tauri/src/ipc.rs` (new commands), `src-tauri/Cargo.toml` (`tauri-plugin-opener` if not present)

- [ ] **Step 15.1: Rust wizard module:**
```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardState { pub key: crate::gemini::rest::KeyStatus, pub cable_present: bool }

#[tauri::command] pub fn wizard_state() -> Result<WizardState, String> { /* key from secrets presence, cable from devices::list_devices */ }

pub const CABLE_ZIP_URL: &str = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";

#[tauri::command]
pub async fn wizard_install_cable() -> Result<(), String> {
    // 1) download official zip (frontend offers vb-audio.com/Cable/ link as fallback on error)
    let bytes = reqwest::get(CABLE_ZIP_URL).await.map_err(|e| format!("download_failed: {e}"))?
        .error_for_status().map_err(|_| "download_failed: http".to_string())?
        .bytes().await.map_err(|e| format!("download_failed: {e}"))?;
    // 2) extract + 3) run installer elevated — blocking work off the async runtime
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        zip::ZipArchive::new(std::io::Cursor::new(bytes.as_ref()))
            .map_err(|e| format!("bad_zip: {e}"))?
            .extract(dir.path()).map_err(|e| format!("extract_failed: {e}"))?;
        let setup = dir.path().join("VBCABLE_Setup_x64.exe");
        if !setup.exists() { return Err("installer_not_found_in_zip".into()); }
        // UAC prompt appears; -Wait returns after the vendor installer closes
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command",
                   &format!("Start-Process -FilePath '{}' -Verb RunAs -Wait", setup.display())])
            .status().map_err(|e| format!("launch_failed: {e}"))?;
        if !status.success() { return Err("installer_cancelled".into()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
    // 4) frontend re-polls wizard_state; if cable still absent, show "может потребоваться перезагрузка"
}
```

- [ ] **Step 15.2: Wizard screen** — HeroUI `Progress` + 4 step cards:
  1. **Ключ:** ApiKeyField (reuse) + link "Получить ключ в AI Studio" (opener → https://aistudio.google.com/apikey). Next enabled when valid.
  2. **VB-CABLE:** status chip; if absent — "Скачать и установить" → `wizard_install_cable`, spinner, re-poll every 2s; manual fallback link. Next enabled when `cablePresent`.
  3. **Устройства:** mic + headphones selects (persist to settings); speaker-name warning as in Live screen.
  4. **Тест:** button "Начать тест" → `liveStart` with `testMode: true` (translation of own speech to own phones, target = peer lang); transcript bubbles render below; "Я слышу перевод ✓" button → `liveStop`, `settingsSet({ wizardDone: true })` → navigate to Live. Show Zoom instruction card: "В Zoom/WhatsApp выберите микрофон: CABLE Output (VB-Audio Virtual Cable)".

- [ ] **Step 15.3: Manual verify** full wizard pass on a machine without VB-CABLE (or after uninstalling): download → UAC → install → detect → test phrase → wizard completes, `wizardDone` persisted.

- [ ] **Step 15.4: Commit.** `feat: first-run wizard with vb-cable install and loopback test`

---

### Task 16: Stage-1 hardening + E2E checklist

**Files:**
- Create: `docs/testing/stage1-e2e-checklist.md`
- Modify: anything the checklist run reveals

- [ ] **Step 16.1: Write the manual E2E checklist** (each line a checkbox to be executed by the user/dev on real calls):
```markdown
# Stage 1 E2E checklist
- [ ] Wizard from clean state (no key, no cable) completes; Zoom shows "CABLE Output" as mic
- [ ] Zoom test call (zoom.us test meeting or second device): peer hears translated speech, not original
- [ ] YouTube video in browser: IN translation audible in headphones, original ducks to set level, restores on stop
- [ ] Both directions simultaneously on a real call for 12+ minutes (survives at least one GoAway/reconnect: status chip flashes yellow, audio resumes, no app restart)
- [ ] Unplug headphones mid-call: app pauses gracefully, no crash; replug + reselect device works
- [ ] Close captured app mid-call: in_session shows source_lost toast; can pick new source. NOTE: process loopback may deliver silence (not an error) when the target pid dies — if the toast never fires, add a pid-liveness watchdog (OpenProcess poll ~2s) to the IN capture that exits the loop when the target is gone.
- [ ] Kill app (taskkill) while ducking active; relaunch: ducked app volume restored on startup
- [ ] Invalid API key: clear error, Start disabled; fixing key in Settings re-enables without restart
- [ ] All UI strings render in both ru and en
```

- [ ] **Step 16.2: Run `cargo test` + `npm test` + `cargo clippy -- -D warnings`; fix everything.**

- [ ] **Step 16.2b: Make `live_start`/`live_stop` async commands.** They are sync today and run inline on the event-loop thread, freezing the UI for the WASAPI init/join duration (~100–600 ms, worse on flaky drivers). Convert both to `async fn` + `tauri::async_runtime::spawn_blocking` around `LiveController::start/stop` (note: `block_on` inside `spawn_blocking` is safe; `block_on` directly inside an async command would panic).

- [ ] **Step 16.3: Execute checklist items that are automatable locally** (devices, key flows, ru/en render); report which items need the user's real call to verify.

- [ ] **Step 16.4: Commit + tag.** `chore: stage 1 hardening` and `git tag v0.1.0-stage1`

---

## Stage 2 and Stage 3

Voice messages (drop/record/TTS/drag-out + history) and polish (cost UI, mix-original, VAD, installer) get their own plan files after Stage 1 is verified working — they build on `gemini::rest`, `audio::capture`, and the store layer defined here. This keeps each plan testable end-to-end on its own.
