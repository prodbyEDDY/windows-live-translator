//! Tauri IPC command surface — the frontend contract.
//!
//! Command names and argument shapes here are load-bearing: the React frontend
//! invokes them by exact name. Tauri 2 maps JS camelCase argument keys to the
//! snake_case Rust parameters automatically, and `cfg` arrives as a JSON object
//! deserialized into [`crate::live_ctrl::LiveConfig`] (which is `camelCase`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::audio::devices::{list_audio_apps, list_devices, AppSession, DevicesPayload};
use crate::audio::dsp::{self, StreamResampler};
use crate::gemini::rest::{synthesize_speech, transcribe_translate, validate_key, KeyStatus};
use crate::live_ctrl::{LiveConfig, LiveController};
use crate::store::history::{CallRecord, HistoryStore, VoiceRecord, VoiceUpdate};
use crate::store::secrets::{get_api_key, set_api_key};
use crate::store::settings::{Settings, SettingsStore};
use crate::voice::codec::{encode_voice_ogg, mime_for_ext};
use crate::voice::pipeline::{
    self, source_file_name, translated_file_name, stage_error, RecorderHandle, STAGE_DONE,
    STAGE_SYNTHESIZING, STAGE_TRANSCRIBING,
};

/// Shared application state held by Tauri's managed-state registry.
pub struct AppState {
    pub settings: SettingsStore,
    /// The single in-flight live session, if any. `Mutex<Option<…>>` enforces
    /// "at most one running session" and lets `live_stop` `take` it.
    ///
    /// This is a **`tokio::sync::Mutex`** (not `std::sync::Mutex`) so the guard
    /// can be held across an `.await` in the async `live_start`/`live_stop`
    /// commands. `LiveController` is `Send` (all its fields — `Arc`, atomics,
    /// crossbeam channels, the `LiveSession` mpsc sender, and `JoinHandle<()>`
    /// — are `Send`; the only `!Send` value, the COM `DuckGuard`, lives entirely
    /// inside the ducking thread and is never stored here), so holding the guard
    /// across `spawn_blocking(...).await` is sound and lets us serialize
    /// concurrent starts without a separate "starting" flag.
    pub live: tokio::sync::Mutex<Option<LiveController>>,

    /// Persistent SQLite history (calls + voice messages). `Arc` so the spawned
    /// pipeline tasks (which outlive the command frame) can hold their own
    /// handle to the same store.
    pub history: Arc<HistoryStore>,

    /// Directory holding voice source/translated audio files
    /// (`app_data_dir/voice`, created in setup).
    pub voice_dir: PathBuf,

    /// The single in-flight recording, if any. A plain `std::sync::Mutex` (not
    /// the tokio one) because the recorder commands never hold the guard across
    /// an `.await` — they `take()`/store the handle and drop the guard before
    /// any async work begins.
    pub recorder: std::sync::Mutex<Option<RecorderHandle>>,
}

/// Read the current settings snapshot.
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

/// Merge a partial JSON patch into settings and persist it.
#[tauri::command]
pub fn settings_set(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    state.settings.patch(patch).map_err(|e| e.to_string())
}

/// Report whether an API key is stored, WITHOUT a network round-trip.
///
/// Returns `Missing` if nothing is stored. If a key is present it returns
/// `Valid` optimistically — the UI calls [`api_key_set`] to actually validate
/// against Gemini before trusting it.
#[tauri::command]
pub fn api_key_status() -> KeyStatus {
    match get_api_key() {
        Some(_) => KeyStatus::Valid,
        None => KeyStatus::Missing,
    }
}

/// Validate a candidate API key against Gemini and, only if valid, store it.
#[tauri::command]
pub async fn api_key_set(key: String) -> Result<KeyStatus, String> {
    let status = validate_key(&key).await;
    if matches!(status, KeyStatus::Valid) {
        set_api_key(&key).map_err(|e| e.to_string())?;
    }
    Ok(status)
}

/// Enumerate capture/render devices and the virtual-cable presence flag.
#[tauri::command]
pub fn devices_list() -> Result<DevicesPayload, String> {
    list_devices().map_err(|e| e.to_string())
}

/// List processes with an active audio session (the app picker source).
#[tauri::command]
pub fn audio_apps_list() -> Result<Vec<AppSession>, String> {
    list_audio_apps().map_err(|e| e.to_string())
}

/// Start a live session (OUT pipeline in this task).
///
/// Async so the blocking WASAPI device-open / WS-spawn work (~100–600 ms)
/// runs on a `spawn_blocking` pool thread instead of freezing the UI event
/// loop. The `tokio::sync::Mutex` guard is held across the `.await`, which
/// serializes concurrent `live_start` calls (the second sees `Some(_)` and
/// returns `already_running`) without a race or a separate "starting" flag.
///
/// `LiveController::start` itself calls `tauri::async_runtime::block_on`
/// internally; running it inside `spawn_blocking` is sound (calling `block_on`
/// directly inside this async command would panic — "cannot block_on within a
/// runtime").
///
/// Error strings are part of the contract:
/// * `"no_api_key"` — no key stored; the UI must run the API-key step first.
/// * `"already_running"` — a session is already live.
/// * `"cable_missing"` — live mode but the VB-CABLE render endpoint is absent.
#[tauri::command]
pub async fn live_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: LiveConfig,
) -> Result<(), String> {
    // Hold the async guard across the await: this both reserves the single slot
    // (rejecting a concurrent second start) and lets us store the controller
    // once built.
    let mut guard = state.live.lock().await;
    if guard.is_some() {
        return Err("already_running".to_string());
    }

    let api_key = get_api_key().ok_or_else(|| "no_api_key".to_string())?;

    // Build the controller off the event loop. `LiveController::start` does the
    // blocking device-open + WS spawn (and its own internal `block_on`), so it
    // must run inside `spawn_blocking`, not inline.
    let controller = tauri::async_runtime::spawn_blocking(move || {
        LiveController::start(app, api_key, cfg)
    })
    .await
    .map_err(|e| format!("live_start join: {e}"))?
    .map_err(|e| e.to_string())?;

    *guard = Some(controller);
    Ok(())
}

/// Stop the live session if one is running. A no-op if nothing is live.
///
/// Async so the blocking teardown (joining audio threads, flushing the WS
/// close — up to a few hundred ms) runs on a `spawn_blocking` pool thread
/// instead of freezing the UI event loop. `LiveController::stop` uses
/// `tauri::async_runtime::block_on` internally; running it inside
/// `spawn_blocking` is sound.
#[tauri::command]
pub async fn live_stop(state: State<'_, AppState>) -> Result<(), String> {
    // Take the controller out under the lock, then drop the lock before the
    // (blocking) teardown so a concurrent `live_start` isn't starved.
    //
    // (Tauri requires async commands that borrow `State` to return a `Result`;
    // the teardown itself is infallible, so `Ok(())` is always returned.)
    let controller = state.live.lock().await.take();
    if let Some(controller) = controller {
        let _ = tauri::async_runtime::spawn_blocking(move || controller.stop()).await;
    }
    Ok(())
}

// ── voice pipeline ─────────────────────────────────────────────────────────────
//
// The `voice:progress` event payload mirrors `VoiceProgressEvent` on the
// frontend: `{ id, stage }`. `stage` is one of the strings owned by
// `voice::pipeline` (pending|transcribing|synthesizing|done|error:<short>).

/// Persist `stage` on voice row `id` and emit a matching `voice:progress` event.
///
/// The single chokepoint for stage transitions so the DB and the UI never drift
/// — every stage change in the pipeline goes through here.
fn set_stage(app: &AppHandle, history: &HistoryStore, id: i64, stage: &str) {
    let _ = history.update_voice(
        id,
        VoiceUpdate {
            stage: Some(stage.to_string()),
            ..Default::default()
        },
    );
    let _ = app.emit(
        "voice:progress",
        serde_json::json!({ "id": id, "stage": stage }),
    );
}

/// Run the import (`kind = "in"`) stage machine for `id`: transcribe+translate
/// the source file into `target_lang`, then mark the row done.
///
/// Errors set the row to `error:<short>` and emit; they are never returned
/// (the command that spawned this has already resolved).
async fn run_import_pipeline(
    app: AppHandle,
    history: Arc<HistoryStore>,
    id: i64,
    source_path: PathBuf,
    mime: String,
    target_lang: String,
) {
    set_stage(&app, &history, id, STAGE_TRANSCRIBING);

    let bytes = match std::fs::read(&source_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("voice_import {id}: read source failed: {e}");
            set_stage(&app, &history, id, &stage_error("read_failed"));
            return;
        }
    };

    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            set_stage(&app, &history, id, &stage_error("no_api_key"));
            return;
        }
    };

    match transcribe_translate(&api_key, &bytes, &mime, &target_lang).await {
        Ok(t) => {
            // History may have been cleared (clear_all) while the request was in
            // flight. Re-check before the final update so we don't resurrect a
            // deleted row.
            match history.get_voice(id) {
                Ok(Some(_)) => {}
                Ok(None) => {
                    tracing::info!("voice_import {id}: row cleared mid-flight, skipping update");
                    return;
                }
                Err(e) => {
                    tracing::warn!("voice_import {id}: get_voice before update failed: {e}");
                    return;
                }
            }
            let _ = history.update_voice(
                id,
                VoiceUpdate {
                    source_lang: Some(t.source_lang),
                    transcript: Some(t.transcript),
                    translation: Some(t.translation),
                    ..Default::default()
                },
            );
            set_stage(&app, &history, id, STAGE_DONE);
        }
        Err(e) => {
            tracing::warn!("voice_import {id}: transcribe_translate failed: {e}");
            set_stage(&app, &history, id, &stage_error("transcribe_failed"));
        }
    }
}

/// Run the recording (`kind = "out"`) stage machine for `id`: transcribe the
/// recorded WAV into `peer_lang`, synthesize the translation with `tts_voice`,
/// encode it to Ogg Opus, write the translated file, and mark the row done.
async fn run_record_pipeline(
    app: AppHandle,
    history: Arc<HistoryStore>,
    voice_dir: PathBuf,
    id: i64,
    source_path: PathBuf,
    peer_lang: String,
    tts_voice: String,
) {
    set_stage(&app, &history, id, STAGE_TRANSCRIBING);

    let bytes = match std::fs::read(&source_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("voice_record {id}: read source failed: {e}");
            set_stage(&app, &history, id, &stage_error("read_failed"));
            return;
        }
    };

    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            set_stage(&app, &history, id, &stage_error("no_api_key"));
            return;
        }
    };

    // 1. Transcribe + translate (recorded source is always 16 kHz mono PCM WAV).
    let transcription = match transcribe_translate(&api_key, &bytes, "audio/wav", &peer_lang).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("voice_record {id}: transcribe_translate failed: {e}");
            set_stage(&app, &history, id, &stage_error("transcribe_failed"));
            return;
        }
    };
    let _ = history.update_voice(
        id,
        VoiceUpdate {
            source_lang: Some(transcription.source_lang.clone()),
            transcript: Some(transcription.transcript.clone()),
            translation: Some(transcription.translation.clone()),
            ..Default::default()
        },
    );

    // 2. Synthesize the translation to PCM16 24 kHz.
    set_stage(&app, &history, id, STAGE_SYNTHESIZING);
    let pcm = match synthesize_speech(&api_key, &transcription.translation, &tts_voice).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("voice_record {id}: synthesize_speech failed: {e}");
            set_stage(&app, &history, id, &stage_error("synthesize_failed"));
            return;
        }
    };

    // History may have been cleared (clear_all) while this pipeline was in
    // flight: the row — and any files we'd write — are gone. Re-check right
    // before writing the translated artifact; if the row vanished, skip the
    // write and the final update so we don't recreate an orphan file/row.
    match history.get_voice(id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            tracing::info!("voice_record {id}: row cleared mid-flight, skipping write");
            return;
        }
        Err(e) => {
            tracing::warn!("voice_record {id}: get_voice before write failed: {e}");
            return;
        }
    }

    // 3. Encode to Ogg Opus and write the translated artifact (CPU-bound — run
    //    on a blocking thread so the async runtime isn't stalled).
    let translated_path = voice_dir.join(translated_file_name(id));
    let write_path = translated_path.clone();
    let encode_result = tauri::async_runtime::spawn_blocking(move || {
        let ogg = encode_voice_ogg(&pcm)?;
        std::fs::write(&write_path, &ogg)?;
        anyhow::Ok(())
    })
    .await;

    match encode_result {
        Ok(Ok(())) => {
            let _ = history.update_voice(
                id,
                VoiceUpdate {
                    translated_audio_path: Some(translated_path.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            );
            set_stage(&app, &history, id, STAGE_DONE);
        }
        Ok(Err(e)) => {
            tracing::warn!("voice_record {id}: encode/write failed: {e}");
            set_stage(&app, &history, id, &stage_error("encode_failed"));
        }
        Err(e) => {
            tracing::warn!("voice_record {id}: encode task panicked: {e}");
            set_stage(&app, &history, id, &stage_error("encode_failed"));
        }
    }
}

/// Import a dropped-in audio file: validate, copy into the voice dir, insert a
/// `pending` history row, then spawn the transcribe+translate pipeline.
///
/// Returns the new row id immediately; the UI tracks progress via
/// `voice:progress` events. Error strings are part of the contract:
/// * `"unsupported_format"` — extension not in [`mime_for_ext`].
#[tauri::command]
pub async fn voice_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    target_lang: String,
) -> Result<i64, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "unsupported_format".to_string())?;
    let mime = mime_for_ext(&ext)
        .ok_or_else(|| "unsupported_format".to_string())?
        .to_string();

    // Insert the row FIRST so the id is available for the on-disk file name.
    let dest_placeholder = state.voice_dir.join(source_file_name(0, &ext));
    let id = state
        .history
        .save_voice("in", &dest_placeholder.to_string_lossy(), &target_lang)
        .map_err(|e| e.to_string())?;

    // Now we know the id — copy the source into its canonical location and fix
    // the stored source_path. If the copy fails the source file never
    // materialized, so roll back the freshly-inserted `pending` row (best-effort)
    // instead of leaving a permanently-stuck card the pipeline can never advance.
    let dest = state.voice_dir.join(source_file_name(id, &ext));
    if let Err(e) = std::fs::copy(&src, &dest) {
        let _ = state.history.delete_voice(id);
        return Err(format!("copy_failed: {e}"));
    }
    update_source_path(&state.history, id, &dest);

    let app2 = app.clone();
    let history = Arc::clone(&state.history);
    tauri::async_runtime::spawn(async move {
        run_import_pipeline(app2, history, id, dest, mime, target_lang).await;
    });

    Ok(id)
}

/// Start recording from `mic_id` (or the default mic). Errors with
/// `"already_recording"` if a recording is already in flight.
#[tauri::command]
pub fn voice_record_start(
    state: State<'_, AppState>,
    mic_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.recorder.lock().unwrap();
    if guard.is_some() {
        return Err("already_recording".to_string());
    }
    let handle = RecorderHandle::start(mic_id).map_err(|e| e.to_string())?;
    *guard = Some(handle);
    Ok(())
}

/// Stop the current recording, write a 16 kHz mono PCM WAV source file, insert
/// a `pending` `out` row, and spawn the transcribe→translate→synthesize
/// pipeline. Returns the new row id.
///
/// Errors: `"not_recording"` if nothing is recording; `"too_short"` if the clip
/// is under [`pipeline::MIN_RECORD_SECS`].
#[tauri::command]
pub async fn voice_record_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    my_lang: String,
    peer_lang: String,
    tts_voice: String,
) -> Result<i64, String> {
    // Take the handle out under the lock, then drop the lock before stopping.
    let handle = state
        .recorder
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "not_recording".to_string())?;

    let samples = handle.stop();
    if pipeline::is_too_short(samples.len()) {
        return Err("too_short".to_string());
    }
    // `my_lang` is part of the JS contract but unused here: Gemini auto-detects
    // the spoken (source) language, and the row is tagged with `peer_lang` (the
    // translation target). Bound — not `_`-prefixed — so Tauri's `myLang` arg
    // mapping still resolves. Acknowledge it to silence the unused warning.
    let _ = &my_lang;

    // Insert the row first to get the id for the file name.
    let placeholder = state.voice_dir.join(source_file_name(0, "wav"));
    let id = state
        .history
        .save_voice("out", &placeholder.to_string_lossy(), &peer_lang)
        .map_err(|e| e.to_string())?;

    // Downsample 48k → 16k mono and write a PCM16 WAV (the mime Gemini always
    // accepts). CPU work, but small for a ≤5-min clip. If the write fails the
    // source file never materialized, so roll back the freshly-inserted
    // `pending` row (best-effort) rather than leave a stuck card behind.
    let source_path = state.voice_dir.join(source_file_name(id, "wav"));
    if let Err(e) = write_wav_16k(&samples, &source_path) {
        let _ = state.history.delete_voice(id);
        return Err(format!("wav_write_failed: {e}"));
    }
    update_source_path(&state.history, id, &source_path);

    let history = Arc::clone(&state.history);
    let voice_dir = state.voice_dir.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        run_record_pipeline(app2, history, voice_dir, id, source_path, peer_lang, tts_voice).await;
    });

    Ok(id)
}

/// Re-run the stage machine for an existing row (e.g. after an error). Reads the
/// source file fresh; `out` rows redo the full transcribe→synthesize chain.
///
/// Errors: `"not_found"` if the row is missing; `"source_missing"` if its
/// source file no longer exists; `"unsupported_format"` for an `in` row whose
/// extension is unknown.
#[tauri::command]
pub async fn voice_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let rec = state
        .history
        .get_voice(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not_found".to_string())?;

    let source_path = PathBuf::from(&rec.source_path);
    if !source_path.exists() {
        return Err("source_missing".to_string());
    }

    let history = Arc::clone(&state.history);
    let app2 = app.clone();

    if rec.kind == "out" {
        let voice_dir = state.voice_dir.clone();
        // `tts_voice` isn't stored per-row; use the current settings voice.
        let tts_voice = state.settings.get().tts_voice;
        let peer_lang = rec.target_lang.clone();
        tauri::async_runtime::spawn(async move {
            run_record_pipeline(
                app2, history, voice_dir, id, source_path, peer_lang, tts_voice,
            )
            .await;
        });
    } else {
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .ok_or_else(|| "unsupported_format".to_string())?;
        let mime = mime_for_ext(&ext)
            .ok_or_else(|| "unsupported_format".to_string())?
            .to_string();
        let target_lang = rec.target_lang.clone();
        tauri::async_runtime::spawn(async move {
            run_import_pipeline(app2, history, id, source_path, mime, target_lang).await;
        });
    }

    Ok(())
}

/// List all voice messages (newest first), optionally filtered by `search`.
#[tauri::command]
pub fn voice_list(
    state: State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<VoiceRecord>, String> {
    state
        .history
        .list_voice(search.as_deref())
        .map_err(|e| e.to_string())
}

/// Fetch a single voice message by id.
#[tauri::command]
pub fn voice_get(state: State<'_, AppState>, id: i64) -> Result<Option<VoiceRecord>, String> {
    state.history.get_voice(id).map_err(|e| e.to_string())
}

/// Copy a voice message's audio to `dest` (translated file preferred, falling
/// back to the source when there is no translated artifact).
#[tauri::command]
pub fn voice_export(state: State<'_, AppState>, id: i64, dest: String) -> Result<(), String> {
    let rec = state
        .history
        .get_voice(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not_found".to_string())?;
    let src = rec
        .translated_audio_path
        .filter(|p| Path::new(p).exists())
        .unwrap_or(rec.source_path);
    std::fs::copy(&src, &dest).map_err(|e| format!("copy_failed: {e}"))?;
    Ok(())
}

// ── history ────────────────────────────────────────────────────────────────────

/// List call records (newest first), optionally filtered by `search`.
#[tauri::command]
pub fn history_list_calls(
    state: State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<CallRecord>, String> {
    state
        .history
        .list_calls(search.as_deref())
        .map_err(|e| e.to_string())
}

/// List voice records (newest first), optionally filtered by `search`.
/// (Alias of [`voice_list`] kept for the History screen's naming symmetry.)
#[tauri::command]
pub fn history_list_voice(
    state: State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<VoiceRecord>, String> {
    state
        .history
        .list_voice(search.as_deref())
        .map_err(|e| e.to_string())
}

/// Persist a completed call's transcript and return its row id.
#[tauri::command]
pub fn history_save_call(
    state: State<'_, AppState>,
    my_lang: String,
    peer_lang: String,
    duration_secs: i64,
    transcript_json: String,
) -> Result<i64, String> {
    state
        .history
        .save_call(&my_lang, &peer_lang, duration_secs, &transcript_json)
        .map_err(|e| e.to_string())
}

/// Wipe all history rows AND every file under the voice directory.
#[tauri::command]
pub fn history_clear(state: State<'_, AppState>) -> Result<(), String> {
    state
        .history
        .clear_all(&state.voice_dir)
        .map_err(|e| e.to_string())
}

// ── voice helpers ──────────────────────────────────────────────────────────────

/// Swap a row's placeholder `source_path` for the canonical `{id}-source.*`
/// path now that the id is known. `source_path` isn't part of [`VoiceUpdate`]
/// (it's set once at insert), hence the dedicated store method. Best-effort.
fn update_source_path(history: &HistoryStore, id: i64, path: &Path) {
    let _ = history.set_source_path(id, &path.to_string_lossy());
}

/// Downsample mono 48 kHz f32 `samples` to 16 kHz and write a PCM16 mono WAV at
/// `path` via hound.
fn write_wav_16k(samples: &[f32], path: &Path) -> anyhow::Result<()> {
    let mut resampler = StreamResampler::new(CAPTURE_RATE_HZ, 16_000);
    let mut out = resampler.push(samples);
    // Flush the resampler's tail with a short block of silence so the final real
    // samples are emitted (the streaming resampler holds a partial input block).
    out.extend(resampler.push(&vec![0.0f32; CAPTURE_RATE_HZ / 100]));
    let pcm16 = dsp::f32_to_i16(&out);

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)?;
    for s in pcm16 {
        writer.write_sample(s)?;
    }
    writer.finalize()?;
    Ok(())
}

/// Mic capture rate (mono 48 kHz). Local alias to keep `write_wav_16k` readable.
const CAPTURE_RATE_HZ: usize = crate::audio::capture::CAPTURE_RATE;
