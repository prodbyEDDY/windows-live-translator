# Logs Page & Detailed Diagnostics Logging

**Date:** 2026-06-19

**Status:** Approved

## Goal

Diagnose a customer-only failure of ElevenLabs voice messages — transcription
"hangs" then errors on the customer's machine, while the same flow works for the
developer with the **same API key and `voice_id`**. The app already logs rich
detail via `tracing::*`, but in a windowed release build there is **no console**,
so that detail is invisible; the UI shows only a localized short code
(`transcribe_failed` / `el_synth_failed`) with no underlying HTTP status or body.

This feature adds a **Logs** page to the sidebar that surfaces everything
happening in the background, plus **detailed, clearly-labelled logging** across
the whole voice-message pipeline (transcription → translation → synthesis) and
the ElevenLabs / Gemini REST layers, an **export** button (`.txt` / `.json`),
and a **connection self-test** that pinpoints the exact failure (e.g. ElevenLabs
`401 detected_unusual_activity`, `quota_exceeded`, `voice_not_found`) without
recording a real message.

## Pipeline facts (the answer to "what does what")

The voice-message pipeline runs stages `pending → transcribing → synthesizing →
done` (or `error:<short>`):

1. **Transcription** — **Gemini** (`gemini-3.5-flash` `generateContent`), via
   `gemini::rest::transcribe_translate`. **Not ElevenLabs.**
2. **Translation** — **Gemini**, the **same single request** as transcription
   (one call returns `{sourceLang, transcript, translation}`). **Not ElevenLabs.**
3. **Synthesis (TTS)** — depends on the `ttsProvider` setting:
   - `gemini` → Gemini TTS (`gemini-3.1-flash-tts-preview`),
   - `elevenlabs` → ElevenLabs convert (`eleven_multilingual_v2`, `pcm_24000`).

ElevenLabs is therefore used **only at the final "synthesizing" step** (and at
credential validation). The "transcribing" stage the customer sees hang is
Gemini. The logging must make it unambiguous **which** stage and **which**
provider failed, with the raw HTTP status + body.

## Scope

Covers:

- a backend log-capture layer (`tracing` Layer) that fans every log event into a
  bounded in-memory ring buffer, a rotating `.jsonl` file under app-data, and a
  live `log:entry` Tauri event;
- commands: `logs_get`, `logs_clear`, `logs_export`, `logs_open_folder`;
- detailed structured logging with timing across the voice pipeline
  (`ipc.rs`), the ElevenLabs REST client, and the Gemini REST client, including
  an ElevenLabs HTTP-error classifier built from the documented taxonomy;
- a connection self-test (`elevenlabs_self_test`, `gemini_self_test`) that makes
  real probe calls and returns a structured verdict;
- a new **Logs** sidebar screen: a diagnostics card (self-test buttons), a
  console-style filterable log list, and export / clear / open-folder actions;
- automated tests (Rust unit + frontend render/behaviour).

Does **not**:

- change the live-call translation path (Gemini Live audio-to-audio) — only its
  logs are captured passively;
- alter pipeline behaviour, stages, or error short codes (logging is additive);
- add remote/telemetry log shipping — logs stay local, exported manually;
- introduce `tracing-appender` (it pulls a `time`/`keyring` dependency conflict —
  the file sink is hand-rolled).

## Verified API facts (ElevenLabs error taxonomy)

From current ElevenLabs docs, used to build `classify_elevenlabs_tts_error`:

| HTTP | Error type / common codes | Meaning |
|------|---------------------------|---------|
| 400  | `validation_error`, `invalid_request`, `text_too_long`, `empty_text`, `invalid_voice_id`, `unsupported_model` | Bad parameters / malformed request |
| 401  | `authentication_error`, `invalid_api_key`, `missing_api_key`, **`detected_unusual_activity`** | Bad/missing key **or** Free-tier disabled for flagged IP/VPN/region |
| 402  | `payment_required`, `insufficient_credits` | Out of credits / quota for the billing window |
| 403  | `authorization_error`, `feature_not_available`, `voice_access_denied`, `model_access_denied` | Key lacks permission for voice/model/feature |
| 404  | `not_found`, `voice_not_found`, `model_not_found` | Voice/model id does not exist for that account |
| 429  | `rate_limit_exceeded`, `concurrent_limit_exceeded` | Too many / too-concurrent requests |
| 5xx  | `internal_error` (500), `service_unavailable` (503) | ElevenLabs server-side |

**Prime suspect for "works for me, not for the customer":** `401
detected_unusual_activity` — ElevenLabs disables **Free-tier** usage from IPs it
flags (VPNs, datacenters, some regions). A paid-tier developer is unaffected; a
free-tier / VPN customer gets 401 with a valid key. The classifier detects this
by scanning the response body, not just the status.

Sources:
- <https://elevenlabs.io/docs/eleven-api/resources/errors>
- <https://help.elevenlabs.io/hc/en-us/articles/19572237925521-API-Error-Code-400-or-401-API-Key>

## Architecture

### Backend — `src-tauri/src/logbus.rs` (new)

- **`LogEntry`** — `{ seq: u64, ts: String (RFC3339, local offset), level: String,
  target: String, message: String, fields: serde_json::Map<String, Value> }`.
  `serde(rename_all = "camelCase")` to mirror into TS.
- **`LogBus`** (global `OnceLock`):
  - `Mutex<VecDeque<LogEntry>>` ring, cap `MAX_RING = 5000` (evict oldest);
  - `AtomicU64` seq;
  - `Mutex<Option<AppHandle>>` set in `setup()` (emit `log:entry` once available;
    before that, events go to ring/file only);
  - `Mutex<Option<FileSink>>` (path + open handle) set in `setup()`; hand-rolled
    rotation: when the file passes `MAX_FILE_BYTES` (~5 MB) rename to
    `app.1.jsonl` (keep one previous), reopen `app.jsonl`.
- **`LogBusLayer`** — `impl Layer<S> for LogBusLayer`; `on_event` runs a
  `Visit`or that captures `message` and every field into the map, builds a
  `LogEntry`, and calls `LogBus::push` (ring + file + emit). Keep `on_event`
  cheap and panic-free (failures in logging must never crash the app).
- **`mask_secret(s: &str) -> String`** — `"abcd…wxyz (len=NN)"`; empty → `"<none>"`.
  Short secrets (≤ 8) fully masked as `"•••• (len=NN)"`.
- **Pure formatting helpers** (unit-tested): `format_txt_line(&LogEntry) ->
  String` (e.g. `2026-06-19 14:03:11.482  WARN  voice  synth failed  http_status=401
  el_error_code=detected_unusual_activity`), and `export_bytes(entries, format)`.
- **Commands:**
  - `logs_get() -> Vec<LogEntry>` — ring snapshot;
  - `logs_clear()` — clear ring (file keeps its rolling history);
  - `logs_export(dest: String, format: String /* "txt" | "json" */)` — read ring,
    serialize, write to `dest` (mirrors `voice_export`);
  - `logs_open_folder()` — reveal the logs directory via `tauri-plugin-opener`.

### Backend — tracing init (`src-tauri/src/lib.rs`)

Replace `tracing_subscriber::fmt().with_env_filter(filter).try_init()` with a
layered registry:

```
registry()
  .with(env_filter)        // RUST_LOG or default "info,live_translator_lib=debug"
  .with(fmt_layer)         // keep stdout for dev
  .with(LogBusLayer::new())
  .try_init()
```

In `.setup()`: create `app_data/logs/`, then
`logbus::install_sink(app.handle().clone(), logs_dir)` to wire the emit handle +
file. Register the four `logs_*` commands and the two self-test commands.

### Backend — detailed pipeline logging (`src-tauri/src/ipc.rs`)

Additive `tracing` calls with structured fields and per-stage timing
(`std::time::Instant`). Helper `set_stage` already centralizes transitions; add a
log there plus richer logs at the call sites:

- `voice_import` / `voice_record_stop`: `tracing::info!(target: "voice", id, kind,
  target_lang, source_bytes, mime, provider, voice_id = %mask, "voice job queued")`.
- `run_import_pipeline` / `run_record_pipeline`:
  - per stage: `tracing::info!(target: "voice", id, stage, elapsed_ms, "stage →")`;
  - transcribe: before (`model`, `mime`, `bytes`, `inline|files_api`, `target_lang`),
    after success (`source_lang`, `transcript_len`, `translation_len`, `latency_ms`)
    or failure (`error = %e` — already carries HTTP status + body);
  - synth: resolved `SynthPlan` (`provider`, `voice_id = %mask`, `model`, or
    pre-flight `el_no_key`/`el_no_voice`); success (`samples`, `latency_ms`) or
    failure (`short`, `error = %e`);
  - encode/write: `bytes`, `latency_ms`.
- Full transcript/translation **text** is logged (per the privacy decision); only
  API keys are masked.

### Backend — `src-tauri/src/elevenlabs/rest.rs`

- New pure `classify_elevenlabs_tts_error(status: u16, body: &str) ->
  ElevenTtsError { http_status, code: &'static str, human: String }` implementing
  the taxonomy table, including body-scan for `detected_unusual_activity`,
  `quota_exceeded`, `voice_not_found`, etc. Unit-tested per row.
- `synthesize_elevenlabs`: `tracing::info!` request start (`url` with key masked,
  `text_len`, `model`, `voice_id = %mask`); on non-2xx `tracing::error!(target:
  "elevenlabs", http_status, el_error_code, body, voice_id = %mask, model,
  latency_ms, "ElevenLabs TTS failed")` then bail (message unchanged); on success
  `tracing::info!(samples, latency_ms)`.
- `validate_elevenlabs`: log the classification + status/body.

### Backend — `src-tauri/src/gemini/rest.rs`

- `call_generate_content`, `synthesize_speech`, `upload_audio_file`: on non-2xx,
  `tracing::warn!(target: "gemini", http_status, body, model, latency_ms, …)`
  before bailing; on success a `tracing::debug!` with `latency_ms`. Behaviour and
  returned error strings unchanged.

### Backend — self-test (`src-tauri/src/ipc.rs`)

- `elevenlabs_self_test() -> ElevenSelfTest` — reads stored key (keyring) + voice
  id (settings); runs `validate_elevenlabs` then a tiny
  `synthesize_elevenlabs(…, "Test.")`; both log richly. Returns
  `{ keyPresent, voiceId (masked), validate { ok, httpStatus, code, detail },
  synth { ok, httpStatus, code, samples, detail } }`.
- `gemini_self_test() -> GeminiSelfTest` — `validate_key` + a minimal
  `synthesize_speech("Test.", default_voice)` probe; returns the analogous shape.
- Both write `tracing::info!("self-test started/finished …")` markers so the
  Logs page shows the probe inline.

### Frontend

- **`src/lib/ipc.ts`** — add `LogEntry`, `ElevenSelfTest`, `GeminiSelfTest` types;
  `logsGet`, `logsClear`, `logsExport`, `logsOpenFolder`, `elevenlabsSelfTest`,
  `geminiSelfTest`, and `onLogEntry(cb)` listening on `log:entry`.
- **`src/lib/logs.ts`** (new, pure + unit-tested) — `LEVELS` ordering,
  `filterLogs(entries, { minLevel, query })`, `formatLogLine(entry)` for display.
- **`src/screens/LogsScreen.tsx`** (new):
  - Diagnostics card: "Тест ElevenLabs" / "Тест Gemini" buttons → inline
    pass/fail summary (status + code + detail);
  - toolbar: level filter (All/Error/Warn/Info/Debug), search input, "Очистить",
    "Выгрузить" (save dialog → `.txt`/`.json` via `logs_export`), "Открыть папку";
  - console list: monospace rows (timestamp · level badge · target · message ·
    expandable fields), chronological, auto-scroll to bottom with pause-on-
    scroll-up ("follow" toggle);
  - on mount: `logsGet()` seeds history; `onLogEntry` appends live (capped to last
    ~3000 in component state); unsubscribe on unmount.
- **`src/components/Sidebar.tsx`** — add `{ id: "logs", labelKey: "nav.logs",
  icon: IconLogs }`.
- **`src/components/Icons.tsx`** — add `IconLogs` (terminal/list glyph).
- **`src/App.tsx`** — `case "logs": return <LogsScreen />;`.
- **`src/stores/app.ts`** — extend `Screen` union with `"logs"`. No store state
  for logs (the page owns its subscription; the backend ring is the source of
  truth on reopen).
- **`src/i18n/{en,ru}.json`** — `nav.logs`, `screen.logs`, and a `logs.*`
  namespace (filters, buttons, self-test labels/results, empty state).

## Data flow

```
any tracing::*  ──► LogBusLayer.on_event ──► LogBus.push ──┬─► ring (VecDeque, 5000)
                                                           ├─► app.jsonl (rotating)
                                                           └─► emit "log:entry" ──► LogsScreen (live append)
LogsScreen mount ──► logs_get() ──► ring snapshot (history seed)
Export ──► dialog.save() ──► logs_export(path, fmt) ──► file
Self-test ──► elevenlabs_self_test() / gemini_self_test() ──► real probe (logs richly) ──► verdict card
```

## Error handling

- Logging must never crash or block the app: `on_event`, the file sink, and the
  emit are all best-effort (`let _ = …`; lock-poison tolerant). A failed file
  write is dropped silently (the ring + live event still work).
- The file sink degrades gracefully if the logs dir is unwritable (ring/emit
  continue).
- Self-test surfaces network/credential errors as structured results, never
  throws to the UI.
- API keys are masked in every log line and self-test result.

## Testing

- **Rust unit:** `LogEntry` (de)serialization camelCase; field `Visit`or captures
  message + typed fields; ring cap/eviction; `format_txt_line` /
  `export_bytes("txt"|"json")`; `mask_secret` boundaries;
  `classify_elevenlabs_tts_error` table (one assert per taxonomy row, incl.
  body-scan for `detected_unusual_activity`). Ignored real-API self-test smokes
  gated on env keys (mirrors existing `#[ignore]` smokes).
- **Frontend:** render-smoke for `LogsScreen`; `src/lib/logs.ts` unit tests for
  `filterLogs` (level threshold + query) and `formatLogLine`.

## Files

**New:** `src-tauri/src/logbus.rs`, `src/screens/LogsScreen.tsx`,
`src/lib/logs.ts`, `src/lib/__tests__/logs.test.ts`.

**Modified:** `src-tauri/src/lib.rs`, `src-tauri/src/ipc.rs`,
`src-tauri/src/elevenlabs/rest.rs`, `src-tauri/src/gemini/rest.rs`,
`src/lib/ipc.ts`, `src/App.tsx`, `src/components/Sidebar.tsx`,
`src/components/Icons.tsx`, `src/stores/app.ts`, `src/i18n/en.json`,
`src/i18n/ru.json`, `src/screens/__tests__/render-smoke.test.tsx`.
