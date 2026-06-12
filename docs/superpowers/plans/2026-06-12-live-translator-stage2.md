# Live Translator — Stage 2 (Voice Messages + History) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Stage 1 (v0.1.0-stage1) established all patterns — follow existing module idioms. Spec: `docs/superpowers/specs/2026-06-12-live-translator-design.md` §4.2–4.3, §5, §6.2–6.3, §7.

**Goal:** Drop a voice message → transcript + translation; record in-app → translated voice file (.ogg Opus) draggable into WhatsApp; persistent history (calls + voice messages) in SQLite.

**Models:** transcription+translation `gemini-3.5-flash` (REST generateContent, inline base64 ≤20MB, Files API above); TTS `gemini-3.1-flash-tts-preview`.

**Conventions:** TDD for pure logic; ignored tests for real-API/hardware; `cargo clippy --all-targets -- -D warnings` + `cargo test` + `npm test` + `npm run build` green before every commit; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task S2-1: REST transcribe+translate (`gemini/rest.rs`)

- `pub struct VoiceTranscription { pub source_lang: String, pub transcript: String, pub translation: String }`
- `pub async fn transcribe_translate(api_key: &str, audio: &[u8], mime: &str, target_lang: &str) -> anyhow::Result<VoiceTranscription>`:
  - ≤20MB: `POST {BASE}/models/gemini-3.5-flash:generateContent` (header x-goog-api-key) body: contents = [ {parts: [{inline_data:{mime_type, data: b64}}, {text: PROMPT}]} ] where PROMPT instructs: "Transcribe this audio, then translate the transcript into <target_lang (BCP-47)>. Reply with ONLY a JSON object: {\"sourceLang\": \"<BCP-47>\", \"transcript\": \"...\", \"translation\": \"...\"}".
  - >20MB: Files API resumable upload (`POST {BASE}/../upload/v1beta/files` two-step: start with X-Goog-Upload-Protocol: resumable headers + metadata, then PUT bytes, parse file.uri) → generateContent with `file_data: {mime_type, file_uri}`.
  - Response parse: pull `candidates[0].content.parts[*].text`, strip ```json fences if present, tolerant `parse_voice_json(text) -> Option<VoiceTranscription>` (pure fn, TDD: clean JSON, fenced JSON, surrounding prose, broken → None). One retry on parse failure (re-request with stricter "ONLY JSON" reminder appended).
- Tests: `parse_voice_json` cases (4+); ignored `real_transcribe_smoke` (GEMINI_API_KEY).

### Task S2-2: REST TTS (`gemini/rest.rs`)

- `pub async fn synthesize_speech(api_key: &str, text: &str, voice: &str) -> anyhow::Result<Vec<i16>>` — returns PCM16 mono 24k.
  - `POST {BASE}/models/gemini-3.1-flash-tts-preview:generateContent`, body: contents=[{parts:[{text}]}], generationConfig: {responseModalities:["AUDIO"], speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName: voice}}}}.
  - Response: candidates[0].content.parts[*].inline_data (mime audio/pcm or audio/L16;rate=24000) → base64 → LE i16 (reuse the decode idiom from gemini/types.rs; pure fn `extract_tts_pcm(json) -> Option<Vec<i16>>`, TDD with fixture).
- `pub const TTS_VOICES: &[&str]` — prebuilt voices list (Kore, Puck, Charon, Fenrir, Aoede + the rest from docs; verify names via docs).
- Tests: extract fixture test; ignored `real_tts_smoke`.

### Task S2-3: Voice codec (`voice/codec.rs`, new module `voice`)

- Encode: `pub fn encode_voice_ogg(pcm24k: &[i16]) -> anyhow::Result<Vec<u8>>` — resample 24k→48k (dsp::StreamResampler), encode Opus VOIP mono 48k ~32kbps, mux into OGG (granule positions per RFC 7845, preskip handling). Crates: try `opus` (libopus via cmake — check `cmake --version` first) else `audiopus`; if neither builds on this machine, FALLBACK: `encode_voice_wav` via hound (document deviation loudly in report — spec wants ogg).
- Decode/probe: `pub fn probe_duration(path: &Path) -> Option<f32>` — best-effort: WAV/MP3/FLAC via symphonia (add dep), OggOpus via manual last-granule parse if cheap, else None. Duration is cosmetic.
- `pub fn mime_for_ext(ext: &str) -> Option<&'static str>` — ogg/opus→audio/ogg, mp3, m4a/aac, wav, flac (pure, TDD).
- Tests: encode 1s sine → valid container (decode header magic "OggS" + nonzero size); mime mapping; duration of generated file.

### Task S2-4: History store (`store/history.rs`, rusqlite)

- `HistoryStore::open(path) -> Self` (creates tables): `calls(id INTEGER PK, started_at TEXT, my_lang TEXT, peer_lang TEXT, duration_secs INTEGER, transcript_json TEXT)`; `voice_messages(id INTEGER PK, created_at TEXT, kind TEXT CHECK(kind IN ('in','out')), source_path TEXT, source_lang TEXT, transcript TEXT, translation TEXT, translated_audio_path TEXT, target_lang TEXT)`.
- Methods: `save_call`, `list_calls(search: Option<&str>) -> Vec<CallRecord>`, `save_voice`, `update_voice`, `list_voice(search) -> Vec<VoiceRecord>`, `clear_all(voice_dir: &Path)` (deletes rows AND files under voice_dir). Search = LIKE on transcript fields. All structs Serialize camelCase.
- Mutex<Connection> inside (same pattern as SettingsStore; rusqlite Connection is !Sync). TDD: roundtrip, search, clear removes files (tempdir).

### Task S2-5: Voice pipeline + IPC (`voice/pipeline.rs`, ipc additions, plugins)

- Deps: `npm i @crabnebula/tauri-plugin-drag` wait — verify actual package names: Rust crate `tauri-plugin-drag`, npm `@crabnebula/tauri-plugin-drag`? Check crates.io/npm; register plugin in lib.rs + capability permission. Also `tauri-plugin-dialog` (Rust + `@tauri-apps/plugin-dialog`) for "Сохранить как".
- `AppState` gains `history: HistoryStore`, `voice_dir: PathBuf`, `recorder: Mutex<Option<RecorderHandle>>`.
- Commands:
  - `voice_import(path: String, target_lang: String) -> Result<i64, String>`: copy file into voice_dir (uuid name, keep ext), insert history row (kind "in", stage pending), spawn async task: read bytes → `transcribe_translate` → update row → emit `voice:progress {id, stage}` events at each stage (decoding|transcribing|done|error{message}).
  - `voice_record_start(mic_id: Option<String>) -> Result<(), String>` / `voice_record_stop(my_lang, peer_lang, tts_voice) -> Result<i64, String>`: record mic (audio::capture Mic → accumulate f32 48k, cap 5 min, downsample 16k? keep 48k→encode source ogg for replay + send to Gemini as WAV 16k mono PCM (encode small WAV via hound — guaranteed accepted mime audio/wav)); on stop: insert row (kind "out"), spawn task: transcribe_translate(target=peer_lang) → synthesize_speech(translation, tts_voice) → encode_voice_ogg → write `<id>-translated.ogg` → update row → progress events (transcribing|translating|synthesizing|done|error).
  - `voice_get(id)`, `voice_list()`, `history_list_calls(search)`, `history_clear()`, `history_save_call(myLang, peerLang, durationSecs, transcriptJson)`.
  - `voice_drag_out(id)`: resolve translated_audio_path → start native drag via drag plugin (or frontend-side plugin API if the plugin is JS-initiated — check plugin docs; prefer JS API `startDrag({item: [path]})` from the card's onMouseDown, in which case NO rust command needed — just expose the path).
- Asset access for `<audio>` playback: enable `assetProtocol` in tauri.conf.json with scope `$APPDATA/voice/**` + `convertFileSrc` on frontend.
- Tests: pure helpers only (file naming, stage serialization); pipeline integration is ignored/manual.

### Task S2-6: Voice screen (frontend)

- `src/screens/VoiceScreen.tsx`: drop-zone overlay using `getCurrentWebview().onDragDropEvent()` (filter audio exts; non-audio → toast error); record button (toggle, timer, 5min cap shown); card list from `voice_list` + live `voice:progress` updates (zustand: `voiceMessages`, actions load/upsert).
- Card: kind "in" → file name, stage chips, transcript + translation text blocks, copy buttons, audio player (`convertFileSrc(source_path)`); kind "out" → recorded original player, translation text, translated audio player, **drag handle** (drag plugin JS API on mousedown with the translated .ogg path; cursor grab; hint "перетащите в WhatsApp"), "Сохранить как" (dialog plugin save + fs copy via Rust command `voice_export(id, dest)`), disclaimer "придёт как аудиофайл, не как голосовая заметка".
- Retry button on error stage (re-invokes voice_translate path — add command `voice_retry(id, target_lang)` in S2-5 if trivial, else re-import).
- i18n parity; vitest for any pure helpers (ext filter).

### Task S2-7: History screen + call saving (frontend)

- LiveScreen: on stop (and on session end), if transcript non-empty → `history_save_call` with duration + lines JSON; then clearTranscript stays manual.
- `src/screens/HistoryScreen.tsx`: tabs (Звонки / Голосовые), search Input (debounced → list_* with search), call rows expand to full transcript render (reuse TranscriptFeed read-only), voice rows reuse VoiceScreen card (read-only), "Очистить историю" Button with confirm Modal → history_clear → refresh.
- i18n parity; build+tests green.

### Task S2-8: Stage-2 hardening

- Full gates; visual smoke (screenshot VoiceScreen + HistoryScreen into docs/testing/screenshots/); update `docs/testing/stage1-e2e-checklist.md` → add stage-2 items (drop ogg from WhatsApp; record→drag-out lands in WhatsApp as audio; history survives restart; clear wipes files); README feature list update; commit + tag `v0.2.0-stage2`.
