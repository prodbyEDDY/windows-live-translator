# ElevenLabs Cloned-Voice Synthesis for Voice Messages

**Date:** 2026-06-16

**Status:** Approved

## Goal

Let the user voice the translation of their **recorded** voice messages in their own
cloned voice via the ElevenLabs Text-to-Speech API, instead of (or alongside) the
built-in Gemini prebuilt voices. The user clones their voice on the ElevenLabs
platform themselves and pastes the resulting API key and `voice_id` into the app's
settings; both are persisted locally. The synthesized translation remains the same
draggable Ogg/Opus artifact the app already produces, so nothing downstream of
synthesis (encoding, file naming, history, WhatsApp drag-out) changes.

## Scope

This feature covers:

- a new local-only ElevenLabs credential surface: API key in the OS keyring, cloned
  `voice_id` in `settings.json`;
- an explicit per-app "voice provider" toggle (Gemini built-in voices vs. the
  ElevenLabs cloned voice), defaulting to Gemini;
- a new backend module that calls the ElevenLabs TTS `convert` endpoint and returns
  PCM16 @ 24 kHz, plus a credential/voice validation call;
- branching the **recording** synthesis stage to the selected provider, reusing the
  existing Opus encoder and the entire pipeline below synthesis unchanged;
- settings UI to enter/validate credentials and switch provider, and a voice-screen
  indicator reflecting the active provider;
- automated tests (Rust unit + ignored real-API smoke, frontend render/behavior).

It does **not**:

- clone voices inside the app (the user clones externally and pastes the `voice_id`);
- change live-call translation (Gemini Live audio-to-audio is a separate real-time
  path and is untouched);
- synthesize audio for imported/dropped-in clips (they remain transcript+translation
  only, as today);
- expose a model picker or `voice_settings` (stability/similarity/style/speed) — the
  model is a fixed backend default and ElevenLabs' own per-voice defaults are used;
- add any silent fallback between providers — a failed ElevenLabs synthesis surfaces a
  clear error and a retry, never substitutes a different voice.

## Verified API Facts (ElevenLabs, real documentation)

These shape the implementation and were confirmed against current ElevenLabs docs:

- **TTS convert:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`.
  Authentication header is `xi-api-key`. `output_format` is a **query parameter**
  (default `mp3_44100_128`). The JSON body carries `text` (required) and `model_id`
  (optional, defaults to `eleven_multilingual_v2`), plus optional `voice_settings`,
  `language_code`, etc.
  Source: <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>
- **PCM output:** `output_format=pcm_24000` returns **raw, headerless PCM, S16LE,
  24 kHz, mono** — the exact shape the existing codec expects. Tier note: only PCM/WAV
  at **44.1 kHz** require Pro tier or above; `pcm_24000` is available on the lower paid
  tiers. Instant Voice Cloning itself requires a paid plan, so a user with a cloned
  voice already qualifies for `pcm_24000`.
  Sources: <https://elevenlabs.io/docs/api-reference/text-to-speech/convert>,
  <https://elevenlabs.io/blog/pcm-output-format>
- **Validation:** `GET https://api.elevenlabs.io/v1/voices/{voice_id}` with `xi-api-key`.
  A `200` confirms **both** the API key and that the `voice_id` exists for that account
  in a single call; `401/403` indicate a bad key, `404/422` a missing/invalid voice.
  Source: <https://elevenlabs.io/docs/api-reference/voices/get>
- **Model:** `eleven_multilingual_v2` supports 29 languages including Russian,
  English, and Ukrainian, and is ElevenLabs' highest-quality model. Because voice-message
  synthesis is an offline file-producing step (latency is not critical), quality wins
  over the lower-latency Flash/Turbo models, so this is the fixed default.
  Source: <https://elevenlabs.io/blog/eleven-multilingual-v2>

## Architecture

### 1. Credential storage (`store/secrets.rs`)

The current module is hard-wired to a single keyring account (`gemini-api-key`).
Generalize it without disturbing existing call sites:

- Extract a private helper keyed by account name (e.g. `entry_for(account)`, and
  private `get_key(account)` / `set_key(account, value)` / `delete_key(account)`
  carrying today's trim-on-read, empty-rejection, and warn-on-error behavior).
- Keep `get_api_key()` / `set_api_key()` / `delete_api_key()` as thin Gemini wrappers
  (account `"gemini-api-key"`) so no existing caller changes.
- Add `get_elevenlabs_api_key()` / `set_elevenlabs_api_key()` /
  `delete_elevenlabs_api_key()` (account `"elevenlabs-api-key"`).

Both keys live in the Windows Credential Manager under service `"live-translator"`.

### 2. Settings (`store/settings.rs`)

Add two fields to `Settings`, both with serde defaults so existing `settings.json`
files load unchanged (no schema-version bump — the version migration mechanism is only
for flipping the value of an existing default, which this is not):

- `tts_provider: TtsProvider` — a new enum `{ Gemini, Elevenlabs }`,
  `#[serde(rename_all = "lowercase")]`, mirroring the existing `CaptureMode` pattern.
  Default `Gemini`.
- `eleven_voice_id: String` — default `""`.

The existing `tts_voice` (Gemini prebuilt voice name) is retained for the Gemini path.
The fixed model id (`eleven_multilingual_v2`) is a backend constant, not a setting.

### 3. ElevenLabs client module (`elevenlabs/rest.rs`)

New module mirroring `gemini/rest.rs` structure and its own `reqwest::Client`
(`OnceLock`, generous timeout for synthesis):

- `pub const ELEVEN_MODEL_ID: &str = "eleven_multilingual_v2";`
- `pub fn parse_pcm_s16le(bytes: &[u8]) -> Vec<i16>` — interpret raw bytes as LE i16
  samples (drop a trailing orphan byte), the same inner decode used by Gemini's
  `extract_tts_pcm` but with no base64/JSON wrapper. Pure and unit-tested.
- `pub async fn synthesize_elevenlabs(api_key, voice_id, model_id, text) -> Result<Vec<i16>>`
  — `POST /v1/text-to-speech/{voice_id}?output_format=pcm_24000`, header `xi-api-key`,
  body `{"text": text, "model_id": model_id}`. On non-2xx, bail with the HTTP status and
  a truncated body. On success, return `parse_pcm_s16le(&resp.bytes())`.
- `pub fn classify_elevenlabs(status, body) -> KeyStatus` — an EL-specific classifier
  (the Gemini `classify_validation` cannot be reused verbatim because it maps 404/422 to
  `Error`, whereas a missing voice must read as `Invalid`): 200 → `Valid`; 401/403 →
  `Invalid` (bad key); 404/422 → `Invalid` (voice not found); anything else → `Error`.
  Pure and unit-tested. The `KeyStatus` enum itself is reused from `gemini::rest` (a
  shared type), not duplicated.
- `pub async fn validate_elevenlabs(api_key, voice_id) -> KeyStatus` — `GET
  /v1/voices/{voice_id}` with `xi-api-key`, returning `classify_elevenlabs(status, body)`;
  network errors map to `KeyStatus::Error`.

### 4. Synthesis branch (`ipc.rs`)

- Introduce `struct OutSynth { provider: TtsProvider, gemini_voice: String,
  eleven_voice_id: String, eleven_model_id: &'static str }` describing how an outgoing
  (recorded) message should be voiced.
- `voice_record_stop` and `voice_retry` build `OutSynth` from `state.settings.get()`
  (provider, `tts_voice`, `eleven_voice_id`) and pass it into `run_record_pipeline`,
  replacing the bare `tts_voice: String` parameter.
- In `run_record_pipeline`, the `STAGE_SYNTHESIZING` step branches on
  `synth.provider`:
  - `Elevenlabs`: read the ElevenLabs key (`get_elevenlabs_api_key()`); if absent →
    `error:el_no_key`; if `eleven_voice_id` is empty → `error:el_no_voice`; otherwise
    `synthesize_elevenlabs(...)`, mapping any failure to `error:el_synth_failed`.
  - `Gemini` (default): unchanged `synthesize_speech(&api_key, translation, gemini_voice)`.
  - Both branches yield `Vec<i16>` PCM16 @ 24 kHz and rejoin the **existing** common
    path: `encode_voice_ogg(&pcm)` → write `{id}-translated.ogg` → mark done. No change
    below synthesis.

No automatic provider fallback: an ElevenLabs error stops the pipeline with the
specific `error:*` stage, which the existing card UI renders with a retry button.

### 5. IPC command (`ipc.rs`, `lib.rs`)

- `elevenlabs_key_set(key: Option<String>, voice_id: String) -> Result<KeyStatus, String>`,
  mirroring `api_key_set`:
  1. Resolve the key to validate: the provided `key` if non-empty, else the stored
     ElevenLabs key (so the user can change `voice_id` without re-typing the key).
  2. `validate_elevenlabs(resolved_key, voice_id)`.
  3. On `Valid`: persist `voice_id` to settings (`settings.patch`) and, if a new key
     was supplied, `set_elevenlabs_api_key(key)`.
  4. Return the `KeyStatus` for the UI chip.
- Register the command (and keep `tts_voices` as-is for the Gemini picker).

### 6. Frontend

- `lib/ipc.ts`: extend the `Settings` type with `ttsProvider: "gemini" | "elevenlabs"`
  and `elevenVoiceId: string`; add `elevenlabsKeySet(key, voiceId)` binding to
  `elevenlabs_key_set`.
- `screens/SettingsScreen.tsx`: a new `SettingsCard` "Cloned voice (ElevenLabs)"
  containing:
  - a provider toggle (`SettingSwitch`/select writing `ttsProvider`), disabled toward
    ElevenLabs until a valid key+voice are saved;
  - an `ElevenLabsField` component modeled on `ApiKeyField` — a password input for the
    key, a text input for `voice_id` (pre-filled from `elevenVoiceId`), a
    "Save & check" button calling `elevenlabsKeySet`, and a reused `KeyStatusChip`;
  - a helper link to where the user finds their `voice_id`.
- `screens/VoiceScreen.tsx`: show the existing Gemini voice dropdown (`TtsVoiceSelect`)
  only when `ttsProvider === "gemini"`; when `"elevenlabs"`, show a compact
  "Your voice (ElevenLabs)" indicator instead.
- `i18n/ru.json` + `i18n/en.json`: section/labels/hints, status chip strings, and the
  three new error short-codes (`el_no_key`, `el_no_voice`, `el_synth_failed`) wherever
  voice-card errors are localized.

### 7. Error and status taxonomy

- Pipeline stages add three `error:<short>` codes, consumed by the existing
  split-on-first-colon card renderer: `el_no_key`, `el_no_voice`, `el_synth_failed`.
- Credential validation reuses `KeyStatus` (`missing`/`valid`/`invalid`/`error`) and the
  same `KeyStatusChip` UI as the Gemini key.

## Testing

- **Rust unit:** `parse_pcm_s16le` (round-trip and odd-length); convert URL/query
  construction (`voice_id` path + `output_format=pcm_24000` query); `validate_elevenlabs`
  classification mapping including 404/422 → `Invalid`; `OutSynth` provider selection
  yields the expected branch; settings round-trip with the new fields and tolerance of an
  older file missing them.
- **Rust smoke (`#[ignore]`):** real `synthesize_elevenlabs` and `validate_elevenlabs`
  gated on `ELEVENLABS_API_KEY` and a test `voice_id` env var.
- **Frontend:** render-smoke covering the new settings card and fields; the provider
  toggle switching the voice-screen indicator; `ElevenLabsField` save/check happy path
  and error chip. Existing fixtures gain the two new settings fields so the schema
  contract stays covered.

## Out of Scope (YAGNI)

In-app voice cloning; model selection and `voice_settings` controls; ElevenLabs for live
calls or imported clips; multi-voice management; usage/quota display.
