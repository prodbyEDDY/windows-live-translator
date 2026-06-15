# ElevenLabs Cloned-Voice Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice the translation of recorded voice messages in the user's own ElevenLabs cloned voice, selectable via an explicit provider toggle, with the API key in the OS keyring and the `voice_id` in `settings.json`.

**Architecture:** A new `elevenlabs/rest.rs` module calls `POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000` and returns PCM16 @ 24 kHz — the exact shape the existing Opus encoder consumes — so only the synthesis step of `run_record_pipeline` branches by provider; everything below it is unchanged. Credentials validate against `GET /v1/voices/{voice_id}`.

**Tech Stack:** Rust (Tauri 2, reqwest, keyring, anyhow), React/TypeScript (zustand, HeroUI, i18next), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-06-16-elevenlabs-voice-cloning-design.md`

**Conventions:** TDD (test first, watch it fail, implement, watch it pass, commit). After Rust changes run `cargo test` + `cargo clippy` in `src-tauri`. After frontend changes run `npm test` + `npx tsc --noEmit`. Commit per task with a conventional-commit message ending in the `Co-Authored-By` trailer.

---

## Task 1: Settings — `tts_provider` + `eleven_voice_id`

**Files:**
- Modify: `src-tauri/src/store/settings.rs`

- [ ] **Step 1: Add a failing test.** In the `tests` module add:

```rust
#[test]
fn defaults_include_gemini_provider_and_empty_voice() {
    let s = Settings::default();
    assert_eq!(s.tts_provider, TtsProvider::Gemini);
    assert_eq!(s.eleven_voice_id, "");
}

/// An older settings.json predating these keys must still load, defaulting to
/// Gemini + empty voice id (serde `default`).
#[test]
fn load_tolerates_missing_elevenlabs_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, r#"{"myLang":"en","peerLang":"ru"}"#).unwrap();
    let store = SettingsStore::open(path).unwrap();
    assert_eq!(store.get().tts_provider, TtsProvider::Gemini);
    assert_eq!(store.get().eleven_voice_id, "");
}

#[test]
fn roundtrip_persists_elevenlabs_provider_and_voice() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::open(dir.path().join("s.json")).unwrap();
    store
        .patch(serde_json::json!({"ttsProvider": "elevenlabs", "elevenVoiceId": "abc123"}))
        .unwrap();
    let again = SettingsStore::open(dir.path().join("s.json")).unwrap();
    assert_eq!(again.get().tts_provider, TtsProvider::Elevenlabs);
    assert_eq!(again.get().eleven_voice_id, "abc123");
}
```

- [ ] **Step 2: Run, expect failure** — `cargo test --lib store::settings` fails to compile (`TtsProvider`, fields unknown).

- [ ] **Step 3: Implement.** Add the enum next to `CaptureMode`:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TtsProvider { Gemini, Elevenlabs }
```

Add two fields to `struct Settings` (after `tts_voice`), each with a serde default so older files load:

```rust
    /// Which engine voices recorded-message translations: Gemini prebuilt voices
    /// (default) or the user's ElevenLabs cloned voice. Serde `default` keeps older
    /// settings files loading (falls back to Gemini).
    #[serde(default = "default_tts_provider")]
    pub tts_provider: TtsProvider,
    /// The ElevenLabs cloned `voice_id` (non-secret; the API key lives in the
    /// keyring). Empty until the user configures it. Serde `default` → "".
    #[serde(default)]
    pub eleven_voice_id: String,
```

Add the default fn near the other defaults:

```rust
/// Default voice provider for files predating the ElevenLabs feature.
fn default_tts_provider() -> TtsProvider { TtsProvider::Gemini }
```

In `impl Default for Settings`, add the two fields (after `tts_voice: "Kore".into(),`):

```rust
            tts_provider: TtsProvider::Gemini,
            eleven_voice_id: String::new(),
```

(No schema-version bump: the migration mechanism is only for flipping an *existing* default's value, which this is not.)

- [ ] **Step 4: Run, expect pass** — `cargo test --lib store::settings` passes.

- [ ] **Step 5: Commit** — `feat(settings): add ttsProvider + elevenVoiceId (default Gemini)`.

---

## Task 2: Secrets — generalize keyring, add ElevenLabs key

**Files:**
- Modify: `src-tauri/src/store/secrets.rs`

- [ ] **Step 1: Add a failing test** to the `tests` module:

```rust
#[test]
fn set_elevenlabs_key_rejects_empty() {
    assert!(set_elevenlabs_api_key("").is_err());
    assert!(set_elevenlabs_api_key("   ").is_err());
}
```

- [ ] **Step 2: Run, expect failure** — `cargo test --lib store::secrets` fails (`set_elevenlabs_api_key` unknown).

- [ ] **Step 3: Implement.** Refactor `secrets.rs` to key the keyring by account name, keep the Gemini wrappers, add ElevenLabs wrappers. Replace the file body with:

```rust
use keyring::Entry;

const SERVICE: &str = "live-translator";
const GEMINI_ACCOUNT: &str = "gemini-api-key";
const ELEVENLABS_ACCOUNT: &str = "elevenlabs-api-key";

fn entry_for(account: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, account)
}

fn get_key(account: &str) -> Option<String> {
    match entry_for(account) {
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

fn set_key(account: &str, key: &str) -> anyhow::Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(anyhow::anyhow!("API key must not be empty"));
    }
    Ok(entry_for(account)?.set_password(trimmed)?)
}

fn delete_key(account: &str) {
    if let Ok(e) = entry_for(account) {
        let _ = e.delete_credential();
    }
}

// ── Gemini (unchanged public surface) ────────────────────────────────────────
pub fn get_api_key() -> Option<String> { get_key(GEMINI_ACCOUNT) }
pub fn set_api_key(key: &str) -> anyhow::Result<()> { set_key(GEMINI_ACCOUNT, key) }
pub fn delete_api_key() { delete_key(GEMINI_ACCOUNT) }

// ── ElevenLabs ───────────────────────────────────────────────────────────────
pub fn get_elevenlabs_api_key() -> Option<String> { get_key(ELEVENLABS_ACCOUNT) }
pub fn set_elevenlabs_api_key(key: &str) -> anyhow::Result<()> { set_key(ELEVENLABS_ACCOUNT, key) }
pub fn delete_elevenlabs_api_key() { delete_key(ELEVENLABS_ACCOUNT) }
```

Keep the existing `#[cfg(test)] mod tests` block; update its `set_api_key_rejects_empty` test if needed (it still applies) and add the new test from Step 1.

- [ ] **Step 4: Run, expect pass** — `cargo test --lib store::secrets`.

- [ ] **Step 5: Commit** — `refactor(secrets): key keyring by account; add ElevenLabs key`.

---

## Task 3: ElevenLabs client module

**Files:**
- Create: `src-tauri/src/elevenlabs/mod.rs`
- Create: `src-tauri/src/elevenlabs/rest.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod elevenlabs;`)

- [ ] **Step 1: Register the module.** In `lib.rs`, after `pub mod gemini;` add `pub mod elevenlabs;`. Create `elevenlabs/mod.rs` with `pub mod rest;`.

- [ ] **Step 2: Write `rest.rs` with failing tests first.** Create the file with the pure helpers and their tests:

```rust
//! ElevenLabs Text-to-Speech client.
//!
//! Synthesizes translated text into the user's cloned voice via the convert
//! endpoint, requesting raw `pcm_24000` (S16LE, mono, 24 kHz) so the bytes feed
//! straight into [`crate::voice::codec::encode_voice_ogg`] — the same PCM16 @
//! 24 kHz shape Gemini TTS produces. Credential/voice validation hits the
//! get-voice endpoint. The `KeyStatus` taxonomy is shared with Gemini.

use std::sync::OnceLock;
use std::time::Duration;

use crate::gemini::rest::KeyStatus;

const API_BASE: &str = "https://api.elevenlabs.io/v1";

/// Highest-quality multilingual model (29 languages incl. RU/EN/UK). Voice
/// messages are an offline file step, so quality beats the lower-latency models.
pub const ELEVEN_MODEL_ID: &str = "eleven_multilingual_v2";

/// Raw PCM, 24 kHz — matches the encoder's input rate; available on the paid
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
/// 200 → Valid; 401/403 → Invalid (bad key); 404/422 → Invalid (voice not
/// found); anything else → Error. The Gemini classifier can't be reused: it maps
/// 404/422 to Error, but here a missing voice must read as Invalid.
pub fn classify_elevenlabs(status: u16, body: &str) -> KeyStatus {
    let snippet: String = body.chars().take(300).collect();
    match status {
        200 => KeyStatus::Valid,
        401 | 403 => KeyStatus::Invalid { reason: format!("invalid API key: {snippet}") },
        404 | 422 => KeyStatus::Invalid { reason: format!("voice not found: {snippet}") },
        s => KeyStatus::Error { message: format!("HTTP {s}: {snippet}") },
    }
}

/// Synthesize `text` into the cloned `voice_id` using `model_id`. Returns raw
/// PCM16 mono @ 24 kHz.
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
        Err(e) => KeyStatus::Error { message: format!("network: {}", e.without_url()) },
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
        assert!(matches!(classify_elevenlabs(500, "x"), KeyStatus::Error { .. }));
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
    }

    #[tokio::test]
    #[ignore = "needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID env"]
    async fn real_validate_smoke() {
        let key = std::env::var("ELEVENLABS_API_KEY").unwrap();
        let voice = std::env::var("ELEVENLABS_VOICE_ID").unwrap();
        assert!(matches!(validate_elevenlabs(&key, &voice).await, KeyStatus::Valid));
    }
}
```

- [ ] **Step 3: Run, expect pass** — `cargo test --lib elevenlabs` (the four pure tests pass; the two `#[ignore]` smokes are skipped).

- [ ] **Step 4: Lint** — `cargo clippy --all-targets` clean.

- [ ] **Step 5: Commit** — `feat(elevenlabs): TTS convert + get-voice validation client`.

---

## Task 4: Pipeline branch + IPC commands

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs` (register two commands)

- [ ] **Step 1: Add a failing test for the pure synth planner.** In `ipc.rs` add a `#[cfg(test)] mod tests` (or extend an existing one) — first define the planner types in the module body, then the test:

```rust
#[cfg(test)]
mod synth_plan_tests {
    use super::*;
    use crate::store::settings::TtsProvider;

    fn synth(provider: TtsProvider, voice_id: &str) -> OutSynth {
        OutSynth {
            provider,
            gemini_voice: "Kore".into(),
            eleven_voice_id: voice_id.into(),
            eleven_model_id: crate::elevenlabs::rest::ELEVEN_MODEL_ID,
        }
    }

    #[test]
    fn gemini_provider_plans_gemini() {
        let p = plan_out_synth(&synth(TtsProvider::Gemini, ""), false);
        assert!(matches!(p, SynthPlan::Gemini { voice } if voice == "Kore"));
    }

    #[test]
    fn elevenlabs_without_key_fails_no_key() {
        let p = plan_out_synth(&synth(TtsProvider::Elevenlabs, "v1"), false);
        assert!(matches!(p, SynthPlan::Fail("el_no_key")));
    }

    #[test]
    fn elevenlabs_without_voice_fails_no_voice() {
        let p = plan_out_synth(&synth(TtsProvider::Elevenlabs, "  "), true);
        assert!(matches!(p, SynthPlan::Fail("el_no_voice")));
    }

    #[test]
    fn elevenlabs_ready_plans_eleven() {
        let p = plan_out_synth(&synth(TtsProvider::Elevenlabs, "v1"), true);
        assert!(matches!(p, SynthPlan::Eleven { voice_id, .. } if voice_id == "v1"));
    }
}
```

- [ ] **Step 2: Run, expect failure** — `cargo test --lib synth_plan` fails (types/fn unknown).

- [ ] **Step 3: Implement the planner.** Add imports at the top of `ipc.rs`:

```rust
use crate::elevenlabs::rest::{synthesize_elevenlabs, validate_elevenlabs, ELEVEN_MODEL_ID};
use crate::store::secrets::{get_elevenlabs_api_key, set_elevenlabs_api_key};
use crate::store::settings::TtsProvider;
```

Add the planner near the other voice helpers (above `run_record_pipeline`):

```rust
/// How an outgoing (recorded) message should be voiced. Built from settings by
/// the record/retry commands and threaded into the synthesis stage.
pub struct OutSynth {
    pub provider: TtsProvider,
    pub gemini_voice: String,
    pub eleven_voice_id: String,
    pub eleven_model_id: &'static str,
}

/// The resolved synthesis route for a recording (pure; unit-tested).
pub enum SynthPlan<'a> {
    Gemini { voice: &'a str },
    Eleven { voice_id: &'a str, model: &'a str },
    /// Pre-flight failure → this `error:<short>` stage, no network call.
    Fail(&'static str),
}

/// Decide the synthesis route. ElevenLabs requires both a stored key and a
/// non-empty voice id; missing either yields the matching `error:` short code.
pub fn plan_out_synth<'a>(synth: &'a OutSynth, eleven_key_present: bool) -> SynthPlan<'a> {
    match synth.provider {
        TtsProvider::Gemini => SynthPlan::Gemini { voice: &synth.gemini_voice },
        TtsProvider::Elevenlabs => {
            if !eleven_key_present {
                SynthPlan::Fail("el_no_key")
            } else if synth.eleven_voice_id.trim().is_empty() {
                SynthPlan::Fail("el_no_voice")
            } else {
                SynthPlan::Eleven { voice_id: &synth.eleven_voice_id, model: synth.eleven_model_id }
            }
        }
    }
}
```

- [ ] **Step 4: Run, expect pass** — `cargo test --lib synth_plan`.

- [ ] **Step 5: Wire the planner into `run_record_pipeline`.** Change its signature from `tts_voice: String` to `synth: OutSynth`, and replace the synthesis block (the `STAGE_SYNTHESIZING` + `synthesize_speech` section) with:

```rust
    // 2. Synthesize the translation to PCM16 24 kHz via the selected provider.
    set_stage(&app, &history, id, STAGE_SYNTHESIZING);
    let eleven_key = get_elevenlabs_api_key();
    let plan = plan_out_synth(&synth, eleven_key.is_some());
    let is_eleven = matches!(plan, SynthPlan::Eleven { .. });
    let pcm_result = match plan {
        SynthPlan::Gemini { voice } => {
            synthesize_speech(&api_key, &transcription.translation, voice).await
        }
        SynthPlan::Eleven { voice_id, model } => {
            // eleven_key is Some here (planner checked presence).
            synthesize_elevenlabs(
                eleven_key.as_deref().unwrap_or_default(),
                voice_id,
                model,
                &transcription.translation,
            )
            .await
        }
        SynthPlan::Fail(short) => {
            set_stage(&app, &history, id, &stage_error(short));
            return;
        }
    };
    let pcm = match pcm_result {
        Ok(p) => p,
        Err(e) => {
            let short = if is_eleven { "el_synth_failed" } else { "synthesize_failed" };
            tracing::warn!("voice_record {id}: synthesize failed: {e}");
            set_stage(&app, &history, id, &stage_error(short));
            return;
        }
    };
```

- [ ] **Step 6: Build `OutSynth` at the two call sites.** In `voice_record_stop`, replace the spawn that passes `tts_voice` with one that reads settings and builds `OutSynth`:

```rust
    let settings = state.settings.get();
    let synth = OutSynth {
        provider: settings.tts_provider,
        gemini_voice: tts_voice,
        eleven_voice_id: settings.eleven_voice_id,
        eleven_model_id: ELEVEN_MODEL_ID,
    };
    let history = Arc::clone(&state.history);
    let voice_dir = state.voice_dir.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        run_record_pipeline(app2, history, voice_dir, id, source_path, peer_lang, synth).await;
    });
```

In `voice_retry`'s `rec.kind == "out"` branch, replace the `tts_voice` line + spawn with:

```rust
        let voice_dir = state.voice_dir.clone();
        let settings = state.settings.get();
        let synth = OutSynth {
            provider: settings.tts_provider,
            gemini_voice: settings.tts_voice.clone(),
            eleven_voice_id: settings.eleven_voice_id.clone(),
            eleven_model_id: ELEVEN_MODEL_ID,
        };
        let peer_lang = rec.target_lang.clone();
        tauri::async_runtime::spawn(async move {
            run_record_pipeline(app2, history, voice_dir, id, source_path, peer_lang, synth).await;
        });
```

- [ ] **Step 7: Add the two IPC commands** (near `api_key_set`):

```rust
/// Report whether an ElevenLabs key is stored (no network round-trip). `Valid`
/// optimistically when present; the UI calls [`elevenlabs_key_set`] to truly
/// validate it together with the voice id.
#[tauri::command]
pub fn elevenlabs_status() -> KeyStatus {
    match get_elevenlabs_api_key() {
        Some(_) => KeyStatus::Valid,
        None => KeyStatus::Missing,
    }
}

/// Validate an ElevenLabs key + voice id against get-voice and, only if valid,
/// store the key (keyring) and the voice id (settings). An empty `key` reuses
/// the stored key so the voice id can be changed without re-typing it.
#[tauri::command]
pub async fn elevenlabs_key_set(
    state: State<'_, AppState>,
    key: Option<String>,
    voice_id: String,
) -> Result<KeyStatus, String> {
    let voice_id = voice_id.trim().to_string();
    if voice_id.is_empty() {
        return Ok(KeyStatus::Invalid { reason: "voice_id is empty".into() });
    }
    let provided = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let resolved = match provided.clone() {
        Some(k) => k,
        None => match get_elevenlabs_api_key() {
            Some(k) => k,
            None => return Ok(KeyStatus::Missing),
        },
    };

    let status = validate_elevenlabs(&resolved, &voice_id).await;
    if matches!(status, KeyStatus::Valid) {
        if let Some(k) = provided {
            set_elevenlabs_api_key(&k).map_err(|e| e.to_string())?;
        }
        state
            .settings
            .patch(serde_json::json!({ "elevenVoiceId": voice_id }))
            .map_err(|e| e.to_string())?;
    }
    Ok(status)
}
```

- [ ] **Step 8: Register both commands** in `lib.rs` `invoke_handler!` (after `ipc::api_key_set,`):

```rust
            ipc::elevenlabs_status,
            ipc::elevenlabs_key_set,
```

- [ ] **Step 9: Run + lint** — `cargo test --lib` (all pass) and `cargo clippy --all-targets` (clean).

- [ ] **Step 10: Commit** — `feat(voice): synthesize recordings via ElevenLabs when selected`.

---

## Task 5: Frontend types, bindings, fixtures

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/stores/__tests__/app.test.ts`
- Modify: `src/lib/__tests__/wizard.test.ts`

- [ ] **Step 1: Extend the `Settings` interface** in `ipc.ts` (after `ttsVoice: string;`):

```ts
  /** Which engine voices recorded-message translations. */
  ttsProvider: "gemini" | "elevenlabs";
  /** ElevenLabs cloned voice id (the API key lives in the OS keyring). */
  elevenVoiceId: string;
```

- [ ] **Step 2: Add the IPC bindings** to the `ipc` object (after `apiKeySet`):

```ts
  elevenlabsStatus: () => invoke<KeyStatus>("elevenlabs_status"),
  elevenlabsKeySet: (key: string | null, voiceId: string) =>
    invoke<KeyStatus>("elevenlabs_key_set", { key, voiceId }),
```

- [ ] **Step 3: Update both fixtures** so the typed `Settings` literals compile. In `app.test.ts` `BASE_SETTINGS` and `wizard.test.ts` `base`, add after the `ttsVoice` line:

```ts
  ttsProvider: "gemini",
  elevenVoiceId: "",
```

- [ ] **Step 4: Run** — `npm test` (Vitest) green; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `feat(ipc): ElevenLabs settings types + bindings`.

---

## Task 6: Settings UI — ElevenLabs card

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Add i18n keys.** In both files under `settings`, add a section title and a `voiceClone` block. `en.json` — add `"voiceClone": "Cloned voice (ElevenLabs)"` to `settings.sections`, and:

```json
    "voiceClone": {
      "sectionDesc": "Voice the translation of your recorded messages in your own ElevenLabs cloned voice. The API key is stored only on this computer; the voice id in settings.",
      "useClone": "Use my cloned voice for recorded messages",
      "useCloneHint": "When on, recorded voice messages are voiced by ElevenLabs using the voice id below. When off, the built-in Gemini voice is used.",
      "keyPlaceholder": "ElevenLabs API key",
      "voiceIdPlaceholder": "Voice ID (e.g. 21m00Tcm4TlvDq8ikWAM)",
      "saveCheck": "Save / Check",
      "getVoiceId": "Where do I find my Voice ID?",
      "needConfig": "Enter and check a valid key + voice id to enable"
    }
```

`ru.json` — add `"voiceClone": "Клонированный голос (ElevenLabs)"` to `settings.sections`, and:

```json
    "voiceClone": {
      "sectionDesc": "Озвучивайте перевод ваших записанных сообщений собственным клонированным голосом ElevenLabs. Ключ хранится только на этом компьютере; ID голоса — в настройках.",
      "useClone": "Озвучивать записанные сообщения моим клоном",
      "useCloneHint": "Когда включено, записанные голосовые озвучиваются через ElevenLabs голосом по указанному ниже ID. Когда выключено — используется встроенный голос Gemini.",
      "keyPlaceholder": "API-ключ ElevenLabs",
      "voiceIdPlaceholder": "Voice ID (например, 21m00Tcm4TlvDq8ikWAM)",
      "saveCheck": "Сохранить / Проверить",
      "getVoiceId": "Где взять мой Voice ID?",
      "needConfig": "Введите и проверьте корректные ключ и voice id, чтобы включить"
    }
```

- [ ] **Step 2: Add the `ElevenLabsField` component** to `SettingsScreen.tsx` (modeled on `ApiKeyField`; reuses `KeyStatusChip`). Add the imports `useState` (from react) and `Spinner` (from @heroui/react), `ipc`, `KeyStatusChip`, `IconEye`/`IconEyeOff` if not present, then:

```tsx
function ElevenLabsField() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const setLastError = useAppStore((s) => s.setLastError);
  const [key, setKey] = useState("");
  const [voiceId, setVoiceId] = useState(settings?.elevenVoiceId ?? "");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSaveCheck() {
    const vid = voiceId.trim();
    if (!vid) return;
    setLoading(true);
    try {
      const st = await ipc.elevenlabsKeySet(key.trim() || null, vid);
      setStatus(st);
      if (st.state === "valid") {
        setKey("");
        // Persist voice id locally even though the backend already did, so the
        // store reflects it immediately for the provider toggle gating.
        await patchSettings({ elevenVoiceId: vid });
      }
    } catch (e) {
      setLastError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <input
          type={showKey ? "text" : "password"}
          placeholder={t("settings.voiceClone.keyPlaceholder")}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="w-full h-11 pl-3.5 pr-10 rounded-input border border-hairline bg-surface text-body text-ink placeholder:text-muted hover:border-hairline-strong focus:border-cobalt outline-none transition-colors font-mono"
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors rounded"
        >
          {showKey ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="text"
          placeholder={t("settings.voiceClone.voiceIdPlaceholder")}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSaveCheck()}
          className="flex-1 min-w-56 h-11 px-3.5 rounded-input border border-hairline bg-surface text-body text-ink placeholder:text-muted hover:border-hairline-strong focus:border-cobalt outline-none transition-colors font-mono"
        />
        <button
          onClick={() => void handleSaveCheck()}
          disabled={loading || voiceId.trim().length === 0}
          className="lt-press shrink-0 h-11 px-5 rounded-pill bg-cobalt hover:bg-cobalt-deep disabled:opacity-40 disabled:hover:bg-cobalt text-white text-caption font-medium inline-flex items-center justify-center min-w-24"
        >
          {loading ? <Spinner size="sm" /> : t("settings.voiceClone.saveCheck")}
        </button>
        <KeyStatusChip status={status} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the settings card + provider toggle** in `SettingsScreen`'s JSX, after the API-key card and before the Audio card:

```tsx
        {/* ---- Cloned voice (ElevenLabs) ---- */}
        <SettingsCard
          title={t("settings.sections.voiceClone")}
          description={t("settings.voiceClone.sectionDesc")}
        >
          <ElevenLabsField />
          <SettingSwitch
            selected={settings.ttsProvider === "elevenlabs"}
            onChange={(c) =>
              void patchSettings({ ttsProvider: c ? "elevenlabs" : "gemini" })
            }
            label={t("settings.voiceClone.useClone")}
            hint={
              settings.elevenVoiceId
                ? t("settings.voiceClone.useCloneHint")
                : t("settings.voiceClone.needConfig")
            }
          />
          <button
            onClick={() =>
              void openUrl("https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning")
            }
            className="text-caption text-cobalt hover:text-cobalt-deep hover:underline self-start rounded"
          >
            {t("settings.voiceClone.getVoiceId")}
          </button>
        </SettingsCard>
```

Ensure `KeyStatus` is imported from `../lib/ipc` and `KeyStatusChip` from `../components/ApiKeyField` (export it if not already — it is exported). Add `ipc` import from `../lib/ipc`.

- [ ] **Step 4: Run** — `npm test`, `npx tsc --noEmit`, and `npm run build` clean.

- [ ] **Step 5: Commit** — `feat(settings): ElevenLabs cloned-voice card + provider toggle`.

---

## Task 7: Voice screen indicator + error localization

**Files:**
- Modify: `src/screens/VoiceScreen.tsx`
- Modify: `src/components/VoiceCard.tsx`
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Add i18n.** Under `voice` in both files add `voiceCloneLabel` and a `stageError` map. `en.json`:

```json
    "voiceCloneLabel": "🎙 Your voice",
    "stageError": {
      "no_api_key": "No Gemini API key",
      "read_failed": "Could not read the recording",
      "transcribe_failed": "Transcription failed",
      "synthesize_failed": "Speech synthesis failed",
      "encode_failed": "Audio encoding failed",
      "el_no_key": "No ElevenLabs API key — add it in Settings",
      "el_no_voice": "No ElevenLabs voice id — add it in Settings",
      "el_synth_failed": "ElevenLabs synthesis failed — check key, voice and quota"
    }
```

`ru.json`:

```json
    "voiceCloneLabel": "🎙 Ваш голос",
    "stageError": {
      "no_api_key": "Нет ключа Gemini",
      "read_failed": "Не удалось прочитать запись",
      "transcribe_failed": "Не удалось распознать речь",
      "synthesize_failed": "Не удалось синтезировать речь",
      "encode_failed": "Не удалось закодировать аудио",
      "el_no_key": "Нет ключа ElevenLabs — добавьте в настройках",
      "el_no_voice": "Нет voice id ElevenLabs — добавьте в настройках",
      "el_synth_failed": "Сбой синтеза ElevenLabs — проверьте ключ, голос и квоту"
    }
```

- [ ] **Step 2: Localize the error tooltip in `VoiceCard.tsx`.** Replace the `errMsg` tooltip content `{errMsg}` with a localized lookup. Add near the top of the component (after `const errMsg = errorMessage(record.stage);`):

```tsx
  const errLabel = errMsg
    ? (i18n.exists(`voice.stageError.${errMsg}`)
        ? t(`voice.stageError.${errMsg}`)
        : errMsg)
    : null;
```

Then in the JSX change `<TooltipContent>{errMsg}</TooltipContent>` to `<TooltipContent>{errLabel}</TooltipContent>`. (`i18n` is already destructured from `useTranslation()`.)

- [ ] **Step 3: Make the voice picker provider-aware in `VoiceScreen.tsx`.** In `TtsVoiceSelect`, read the provider and short-circuit to the clone indicator when active. Replace the start of `TtsVoiceSelect` body:

```tsx
function TtsVoiceSelect() {
  const { t } = useTranslation();
  const provider = useAppStore((s) => s.settings?.ttsProvider ?? "gemini");
  const ttsVoice = useAppStore((s) => s.settings?.ttsVoice ?? "Kore");
  const patchSettings = useAppStore((s) => s.patchSettings);
  const [voices, setVoices] = useState<string[]>([]);

  useEffect(() => {
    ipc
      .ttsVoices()
      .then((v) => setVoices(Array.isArray(v) ? v : []))
      .catch(() => setVoices([]));
  }, []);

  if (provider === "elevenlabs") {
    return (
      <span className="inline-flex items-center gap-1.5 h-9 px-3 rounded-pill border border-cobalt/30 bg-cobalt-tint text-caption font-medium text-cobalt-deep">
        {t("voice.voiceCloneLabel")}
      </span>
    );
  }

  const items = (voices?.length ? voices : [ttsVoice]).map((v) => ({ id: v }));
  // …unchanged Gemini dropdown below…
```

(Keep the rest of the Gemini `SelectRoot` block exactly as-is.)

- [ ] **Step 4: Run** — `npm test`, `npx tsc --noEmit`, `npm run build` clean.

- [ ] **Step 5: Commit** — `feat(voice): clone-voice indicator + localized stage errors`.

---

## Task 8: Full verification

- [ ] **Step 1: Rust** — in `src-tauri`: `cargo test` (all pass, ignored smokes skipped) and `cargo clippy --all-targets -- -D warnings` (clean).
- [ ] **Step 2: Frontend** — `npm test`, `npx tsc --noEmit`, `npm run build` (all green).
- [ ] **Step 3: Manual smoke (optional, needs a real ElevenLabs key + cloned voice):** in Settings enter the key + voice id → Save/Check shows "valid"; turn on the provider toggle; on the Voice screen the picker shows "🎙 Your voice"; record a short clip → the translated card synthesizes and the draggable `.ogg` plays in the cloned voice. With the toggle off, recording uses the Gemini voice as before.
- [ ] **Step 4: Final commit if any fixups** — `chore: verify ElevenLabs voice-cloning feature`.

---

## Self-Review Notes

- **Spec coverage:** storage (Task 1+2), client module (Task 3), pipeline branch + commands (Task 4), frontend types (Task 5), settings UI/toggle (Task 6), voice indicator + errors (Task 7), tests throughout, verification (Task 8). All spec sections mapped.
- **Type consistency:** `OutSynth`/`SynthPlan`/`plan_out_synth`, `ELEVEN_MODEL_ID`, `parse_pcm_s16le`, `classify_elevenlabs`, `convert_url`, `synthesize_elevenlabs`, `validate_elevenlabs`, `elevenlabs_status`, `elevenlabs_key_set`, `ttsProvider`/`elevenVoiceId` are used consistently across tasks and match the spec.
- **No silent fallback:** the planner returns specific `error:el_*` shorts; the pipeline never substitutes Gemini for a failed ElevenLabs call.
