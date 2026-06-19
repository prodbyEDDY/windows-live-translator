# Voice UX Split + Translation Accuracy Implementation Plan

> Execute task-by-task with TDD where pure logic exists. Steps use `- [ ]`.

**Goal:** Fix voice-message ordering + translation accuracy (es/it → en), split device & language settings per-mode (voice vs live) and surface them on the Live/Voice pages, add a transcription auto-retry via a fallback Gemini model, and handle ElevenLabs-unsupported languages gracefully.

## Root causes (investigated)

- **Sorting:** `store/app.ts loadVoice` does `.reverse()` on a backend list already ordered `id DESC` (newest first) → oldest on top, while `upsertVoice`/progress prepend newest → inconsistent order. Fix: drop `.reverse()`, keep a stable `id`-desc sort in `loadVoice` and `upsertVoice`.
- **Translation → English:** `gemini/rest.rs build_prompt` interpolates the bare BCP-47 code (`"...into es (BCP-47)..."`) — under-specified, model drifts to English. Fix: use the full English language name + an explicit "must be written in {Name}; never English unless target is English" constraint.

## Decisions (confirmed with user)

1. Voice gets its OWN language pair (`voiceMyLang`/`voicePeerLang`), independent of live; migrate by copying current live langs once.
2. Fallback transcription model = `gemini-2.5-flash` (primary stays `gemini-3.5-flash`).
3. UX: surface frequently-used controls (language, devices, voice/provider) on Live & Voice pages; Settings stays the full source of truth (nothing removed).
4. ElevenLabs target language not supported by `eleven_multilingual_v2` → clear error `error:el_lang_unsupported`, NO silent fallback (matches existing "no silent voice substitution" principle).

## Tasks

### Task A — Prompt accuracy + multi-model transcribe retry (`src-tauri/src/gemini/rest.rs`)
- `language_name(code: &str) -> &'static str` — English names for all `LANGUAGES` codes (fallback: the code itself).
- `build_prompt(target_lang)` → `"Transcribe this audio, then translate the transcript into {Name} ({code}). The \"translation\" field MUST be written ONLY in {Name}; never reply in English unless {Name} is English. Reply with ONLY a JSON object: {...}"`.
- `call_generate_content(api_key, body, model: &str)` — add `model` param.
- `TRANSCRIBE_MODELS: &[&str] = &["gemini-3.5-flash", "gemini-2.5-flash"]`.
- `transcribe_translate` loops models: per model try prompt then stricter retry; on hard error OR unparseable-after-retry, log and advance to next model; return the parsed result on first success, else the last error. Upload (Files API) happens once before the loop and the uri is reused.
- Tests: `language_name` known + fallback; `build_prompt` contains the name and the "MUST"/"never English" constraint; `TRANSCRIBE_MODELS` has the fallback.

### Task B — Settings schema + ElevenLabs language preflight
- `settings.rs`: add `voice_mic_id: Option<String>`, `voice_my_lang: String`, `voice_peer_lang: String`; extend `Default` (voice langs default "ru"/"en", voice_mic_id None). Container `#[serde(default)]` already backfills missing fields from `Default`.
- Bump `CURRENT_SCHEMA_VERSION` 1 → 2. In `open()` migration: `if version < 2 { voice_my_lang = my_lang.clone(); voice_peer_lang = peer_lang.clone(); }` then set version = CURRENT, write. (Keep the `< 1` echo flip.)
- Tests: defaults include the new fields; migration copies live langs into voice langs for a v1 file; roundtrip persists voice fields.
- `elevenlabs/rest.rs`: `ELEVEN_SUPPORTED_LANGS: &[&str]` (29 codes for `eleven_multilingual_v2`) + `eleven_supports_lang(code) -> bool` + test.
- `ipc.rs run_record_pipeline`: after resolving an ElevenLabs route, if `!eleven_supports_lang(&peer_lang)` → log + `set_stage(error:el_lang_unsupported)` and return (before the network call).

### Task C — Frontend sorting + ipc types + voice wiring
- `store/app.ts`: `loadVoice` → `set({ voiceMessages: [...voiceMessages].sort((a,b)=>b.id-a.id) })` (no reverse). `upsertVoice` and the `onVoiceProgress` handler: after building the array, sort by `id` desc (helper `sortVoiceDesc`).
- `lib/ipc.ts` `Settings`: add `voiceMicId: string | null`, `voiceMyLang: string`, `voicePeerLang: string`.
- `VoiceScreen.tsx`: record → `voiceRecordStart(settings.voiceMicId)`, `voiceRecordStop(voiceMyLang, voicePeerLang, ttsVoice)`; import drop target → `voiceMyLang`.
- `VoiceCard.tsx handleRetry`: in → `voiceMyLang`; out → `voicePeerLang`.

### Task D — On-page controls + i18n
- `LiveScreen.tsx`: add a compact mic + output picker row (reuse `DeviceSelect` from SettingsScreen, or a compact pill) bound to `micId`/`outputId`. Disabled while a session is running (devices are opened at start).
- `VoiceScreen.tsx`: add a voice language pair (reuse the Header `LangPill` pattern or `LANGUAGES` select) bound to `voiceMyLang`/`voicePeerLang`, and a voice mic picker bound to `voiceMicId`.
- i18n en/ru: `voice.lang.you`, `voice.lang.peer`, `voice.micLabel`, `live.micLabel`, `live.outputLabel`, `voice.stageError.el_lang_unsupported`.

### Task E — Verify
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`; `npm test`; `npm run build`. Fix failures.
