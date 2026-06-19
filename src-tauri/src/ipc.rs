//! Tauri IPC command surface — the frontend contract.
//!
//! Command names and argument shapes here are load-bearing: the React frontend
//! invokes them by exact name. Tauri 2 maps JS camelCase argument keys to the
//! snake_case Rust parameters automatically, and `cfg` arrives as a JSON object
//! deserialized into [`crate::live_ctrl::LiveConfig`] (which is `camelCase`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::audio::devices::{
    cable_render_device_id, list_audio_apps, list_devices, AppSession, DevicesPayload,
};
use crate::audio::dsp::{self, StreamResampler};
use crate::elevenlabs::rest::{
    eleven_supports_lang, probe_synth, probe_validate, synthesize_elevenlabs, validate_elevenlabs,
    ElevenProbe, ELEVEN_MODEL_ID,
};
use crate::gemini::rest::{
    probe_tts, probe_validate_key, synthesize_speech, transcribe_translate, validate_key,
    GeminiProbe, KeyStatus, TTS_VOICES,
};
use crate::logbus::mask_secret;
use crate::live_ctrl::{LiveConfig, LiveController};
use crate::passthrough::Passthrough;
use crate::store::history::{CallRecord, HistoryStore, VoiceRecord, VoiceUpdate};
use crate::store::secrets::{
    get_api_key, get_elevenlabs_api_key, set_api_key, set_elevenlabs_api_key,
};
use crate::store::settings::{Settings, SettingsStore, TtsProvider};
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

    /// The idle mic→cable passthrough, running only when no live session owns
    /// the mic + cable. Plain `std::sync::Mutex`: the helpers never hold it
    /// across an `.await`.
    pub passthrough: std::sync::Mutex<Option<Passthrough>>,
}

/// Start the idle mic→cable passthrough if it should be running: it isn't
/// already, no live session owns the devices, the setting is on, and the cable
/// exists. Safe to call from any command — uses `try_lock` on the live session
/// so it can never deadlock against `live_start`/`live_stop`.
pub fn start_passthrough_if_idle(state: &AppState) {
    let mut pt = state.passthrough.lock().unwrap_or_else(|p| p.into_inner());
    if pt.is_some() {
        return; // already running
    }
    // A live session owns the mic + cable; don't contend. `try_lock` keeps this
    // non-blocking (and deadlock-free) — if the live slot is busy we simply skip.
    match state.live.try_lock() {
        Ok(guard) if guard.is_some() => return, // session running
        Ok(_) => {}                             // idle — proceed
        Err(_) => return,                       // start/stop in flight — skip
    }
    let settings = state.settings.get();
    if !settings.idle_passthrough {
        return;
    }
    let Some(cable) = cable_render_device_id() else {
        return; // no virtual cable — nothing to feed
    };
    match Passthrough::start(settings.mic_id.clone(), cable) {
        Ok(p) => {
            *pt = Some(p);
            tracing::info!("idle mic passthrough started");
        }
        Err(e) => tracing::warn!("idle passthrough failed to start: {e}"),
    }
}

/// Stop the idle passthrough if running (no-op otherwise).
pub fn stop_passthrough(state: &AppState) {
    let taken = state
        .passthrough
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    if let Some(p) = taken {
        p.stop();
    }
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
    // Changing the idle-passthrough toggle or the mic device must re-evaluate the
    // running passthrough (check before the patch consumes the value).
    let touches_passthrough =
        patch.get("idlePassthrough").is_some() || patch.get("micId").is_some();
    let updated = state.settings.patch(patch).map_err(|e| e.to_string())?;
    if touches_passthrough {
        // Re-apply with the new mic / toggle. No-ops while a session is active
        // (it re-evaluates on the next live_stop).
        stop_passthrough(&state);
        start_passthrough_if_idle(&state);
    }
    Ok(updated)
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

/// Report whether an ElevenLabs key is stored, WITHOUT a network round-trip.
/// `Valid` optimistically when present; the UI calls [`elevenlabs_key_set`] to
/// truly validate it together with the voice id.
#[tauri::command]
pub fn elevenlabs_status() -> KeyStatus {
    match get_elevenlabs_api_key() {
        Some(_) => KeyStatus::Valid,
        None => KeyStatus::Missing,
    }
}

/// Validate an ElevenLabs key + voice id against the get-voice endpoint and,
/// only if valid, store the key (keyring) and the voice id (settings). An empty
/// `key` reuses the stored key, so the voice id can be changed without
/// re-typing it.
#[tauri::command]
pub async fn elevenlabs_key_set(
    state: State<'_, AppState>,
    key: Option<String>,
    voice_id: String,
) -> Result<KeyStatus, String> {
    let voice_id = voice_id.trim().to_string();
    if voice_id.is_empty() {
        return Ok(KeyStatus::Invalid {
            reason: "voice_id is empty".into(),
        });
    }
    // Use the supplied key if non-empty, otherwise fall back to the stored one.
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

/// Enumerate capture/render devices and the virtual-cable presence flag.
#[tauri::command]
pub fn devices_list() -> Result<DevicesPayload, String> {
    list_devices().map_err(|e| e.to_string())
}

/// List the available TTS voice names — the single source of truth for the
/// settings voice picker (so the UI never hard-codes a stale list).
#[tauri::command]
pub fn tts_voices() -> Vec<&'static str> {
    TTS_VOICES.to_vec()
}

/// List processes with an active audio session (the app picker source).
#[tauri::command]
pub fn audio_apps_list() -> Result<Vec<AppSession>, String> {
    list_audio_apps().map_err(|e| e.to_string())
}

// ── connection self-tests ─────────────────────────────────────────────────────
//
// These make REAL probe calls (no audio recorded) and log the exact HTTP
// status/body so the Logs page shows the precise cause of a customer's failure
// (e.g. ElevenLabs `detected_unusual_activity`, `voice_not_found`, a Gemini
// region block on transcription). The returned verdict drives the inline card.

/// Result of the ElevenLabs connection self-test.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenSelfTest {
    pub key_present: bool,
    pub voice_id: String,
    pub validate: ElevenProbe,
    pub synth: ElevenProbe,
}

/// Run a real ElevenLabs validate (get-voice) + tiny synth probe and report the
/// verdict. Synthesis is only attempted if validation passed.
#[tauri::command]
pub async fn elevenlabs_self_test(state: State<'_, AppState>) -> Result<ElevenSelfTest, String> {
    let voice_id = state.settings.get().eleven_voice_id;
    let key = match get_elevenlabs_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "elevenlabs", "self-test: no API key stored");
            let miss = ElevenProbe {
                ok: false,
                http_status: None,
                code: Some("no_key".into()),
                detail: "no ElevenLabs key stored".into(),
            };
            return Ok(ElevenSelfTest {
                key_present: false,
                voice_id: mask_secret(&voice_id),
                validate: miss.clone(),
                synth: miss,
            });
        }
    };
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(&voice_id), "self-test: started");
    let validate = probe_validate(&key, &voice_id).await;
    let synth = if validate.ok {
        probe_synth(&key, &voice_id, ELEVEN_MODEL_ID).await
    } else {
        ElevenProbe {
            ok: false,
            http_status: None,
            code: Some("skipped".into()),
            detail: "skipped (validate failed)".into(),
        }
    };
    tracing::info!(target: "elevenlabs", validate_ok = validate.ok, synth_ok = synth.ok, "self-test: finished");
    Ok(ElevenSelfTest {
        key_present: true,
        voice_id: mask_secret(&voice_id),
        validate,
        synth,
    })
}

/// Result of the Gemini connection self-test.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSelfTest {
    pub key_present: bool,
    pub validate: GeminiProbe,
    pub tts: GeminiProbe,
}

/// Run a real Gemini key-validate + tiny TTS probe (transcription uses the same
/// host) and report the verdict.
#[tauri::command]
pub async fn gemini_self_test(state: State<'_, AppState>) -> Result<GeminiSelfTest, String> {
    let key = match get_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "gemini", "self-test: no API key stored");
            let miss = GeminiProbe {
                ok: false,
                http_status: None,
                code: Some("no_key".into()),
                detail: "no Gemini key stored".into(),
            };
            return Ok(GeminiSelfTest {
                key_present: false,
                validate: miss.clone(),
                tts: miss,
            });
        }
    };
    tracing::info!(target: "gemini", "self-test: started");
    let validate = probe_validate_key(&key).await;
    let voice = state.settings.get().tts_voice;
    let voice = if voice.is_empty() { "Kore".to_string() } else { voice };
    let tts = if validate.ok {
        probe_tts(&key, &voice).await
    } else {
        GeminiProbe {
            ok: false,
            http_status: None,
            code: Some("skipped".into()),
            detail: "skipped (validate failed)".into(),
        }
    };
    tracing::info!(target: "gemini", validate_ok = validate.ok, tts_ok = tts.ok, "self-test: finished");
    Ok(GeminiSelfTest {
        key_present: true,
        validate,
        tts,
    })
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

    // The idle passthrough owns the mic + cable while no session runs — release
    // them before the session claims them.
    stop_passthrough(&state);

    // Build the controller off the event loop. `LiveController::start` does the
    // blocking device-open + WS spawn (and its own internal `block_on`), so it
    // must run inside `spawn_blocking`, not inline.
    let app_for_start = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        LiveController::start(app_for_start, api_key, cfg)
    })
    .await
    .map_err(|e| format!("live_start join: {e}"))?;

    match result {
        Ok(controller) => {
            *guard = Some(controller);
            Ok(())
        }
        Err(e) => {
            // Make sure a failed start never leaves the UI showing a phantom
            // "connecting" (which would render a Stop button that can't stop
            // anything, since no controller was stored). `LiveController::start`
            // is structured to emit nothing on failure, but this is cheap
            // insurance and also covers a join/panic error.
            let _ = app.emit(
                "live:state",
                serde_json::json!({ "phase": "off", "outSession": "off", "inSession": "off" }),
            );
            // The session never claimed the devices — bring the idle passthrough
            // back so the peer still hears the original voice.
            start_passthrough_if_idle(&state);
            Err(e.to_string())
        }
    }
}

/// Stop the live session if one is running. A no-op if nothing is live.
///
/// Async so the blocking teardown (joining audio threads, flushing the WS
/// close — up to a few hundred ms) runs on a `spawn_blocking` pool thread
/// instead of freezing the UI event loop. `LiveController::stop` uses
/// `tauri::async_runtime::block_on` internally; running it inside
/// `spawn_blocking` is sound.
#[tauri::command]
pub async fn live_stop(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Take the controller out under the lock, then drop the lock before the
    // (blocking) teardown so a concurrent `live_start` isn't starved.
    //
    // (Tauri requires async commands that borrow `State` to return a `Result`;
    // the teardown itself is infallible, so `Ok(())` is always returned.)
    let controller = state.live.lock().await.take();
    if let Some(controller) = controller {
        let _ = tauri::async_runtime::spawn_blocking(move || controller.stop()).await;
    }
    // The teardown threads emit no state of their own, so the UI would otherwise
    // stay frozen on its last phase ("running"/"connecting") after a stop — the
    // exact "Stop does nothing" symptom. Emit an explicit "off" unconditionally
    // (even when nothing was running) so Stop always returns the UI to idle.
    let _ = app.emit(
        "live:state",
        serde_json::json!({ "phase": "off", "outSession": "off", "inSession": "off" }),
    );
    // Session released the mic + cable — resume the idle passthrough so the peer
    // keeps hearing the original voice without re-selecting a device.
    start_passthrough_if_idle(&state);
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
    tracing::info!(target: "voice", id, stage = %stage, "stage →");
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
    tracing::info!(target: "voice", id, kind = "in", target_lang = %target_lang, mime = %mime, "import pipeline started");
    set_stage(&app, &history, id, STAGE_TRANSCRIBING);

    let bytes = match std::fs::read(&source_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "voice", id, error = %e, "voice_import: read source failed");
            set_stage(&app, &history, id, &stage_error("read_failed"));
            return;
        }
    };
    tracing::info!(target: "voice", id, source_bytes = bytes.len(), "read source file");

    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "voice", id, "voice_import: no Gemini API key");
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
            tracing::info!(target: "voice", id, source_lang = %t.source_lang, transcript_len = t.transcript.chars().count(), translation_len = t.translation.chars().count(), "import transcribe+translate OK");
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
            tracing::warn!(target: "voice", id, error = %e, "voice_import: transcribe_translate failed");
            set_stage(&app, &history, id, &stage_error("transcribe_failed"));
        }
    }
}

/// How an outgoing (recorded) message should be voiced. Built from settings by
/// the record/retry commands and threaded into the synthesis stage so the
/// pipeline reads one struct instead of several loose args.
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
/// non-empty voice id; missing either yields the matching `error:` short code
/// (never a silent fallback to Gemini).
pub fn plan_out_synth<'a>(synth: &'a OutSynth, eleven_key_present: bool) -> SynthPlan<'a> {
    match synth.provider {
        TtsProvider::Gemini => SynthPlan::Gemini {
            voice: &synth.gemini_voice,
        },
        TtsProvider::Elevenlabs => {
            if !eleven_key_present {
                SynthPlan::Fail("el_no_key")
            } else if synth.eleven_voice_id.trim().is_empty() {
                SynthPlan::Fail("el_no_voice")
            } else {
                SynthPlan::Eleven {
                    voice_id: &synth.eleven_voice_id,
                    model: synth.eleven_model_id,
                }
            }
        }
    }
}

/// Run the recording (`kind = "out"`) stage machine for `id`: transcribe the
/// recorded WAV into `peer_lang`, synthesize the translation via the selected
/// provider (`synth`), encode it to Ogg Opus, write the translated file, and
/// mark the row done.
async fn run_record_pipeline(
    app: AppHandle,
    history: Arc<HistoryStore>,
    voice_dir: PathBuf,
    id: i64,
    source_path: PathBuf,
    peer_lang: String,
    synth: OutSynth,
) {
    let job_started = std::time::Instant::now();
    tracing::info!(target: "voice", id, kind = "out", peer_lang = %peer_lang, provider = ?synth.provider, eleven_voice = %mask_secret(&synth.eleven_voice_id), "record pipeline started");
    set_stage(&app, &history, id, STAGE_TRANSCRIBING);

    let bytes = match std::fs::read(&source_path) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(target: "voice", id, error = %e, "voice_record: read source failed");
            set_stage(&app, &history, id, &stage_error("read_failed"));
            return;
        }
    };
    tracing::info!(target: "voice", id, source_bytes = bytes.len(), "read recorded WAV source");

    let api_key = match get_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "voice", id, "voice_record: no Gemini API key");
            set_stage(&app, &history, id, &stage_error("no_api_key"));
            return;
        }
    };

    // 1. Transcribe + translate (recorded source is always 16 kHz mono PCM WAV).
    let transcription = match transcribe_translate(&api_key, &bytes, "audio/wav", &peer_lang).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(target: "voice", id, error = %e, "voice_record: transcribe_translate failed");
            set_stage(&app, &history, id, &stage_error("transcribe_failed"));
            return;
        }
    };
    tracing::info!(target: "voice", id, source_lang = %transcription.source_lang, transcript_len = transcription.transcript.chars().count(), translation_len = transcription.translation.chars().count(), elapsed_ms = job_started.elapsed().as_millis() as u64, "transcribe+translate OK");
    let _ = history.update_voice(
        id,
        VoiceUpdate {
            source_lang: Some(transcription.source_lang.clone()),
            transcript: Some(transcription.transcript.clone()),
            translation: Some(transcription.translation.clone()),
            ..Default::default()
        },
    );

    // 2. Synthesize the translation to PCM16 24 kHz via the selected provider.
    set_stage(&app, &history, id, STAGE_SYNTHESIZING);
    let eleven_key = get_elevenlabs_api_key();
    let plan = plan_out_synth(&synth, eleven_key.is_some());
    match &plan {
        SynthPlan::Gemini { voice } => {
            tracing::info!(target: "voice", id, route = "gemini", voice = %voice, "synth route resolved")
        }
        SynthPlan::Eleven { voice_id, model } => {
            tracing::info!(target: "voice", id, route = "elevenlabs", voice_id = %mask_secret(voice_id), model = %model, "synth route resolved")
        }
        SynthPlan::Fail(short) => {
            tracing::warn!(target: "voice", id, route = "fail", short = %short, "synth pre-flight failed")
        }
    }
    // Pre-flight: ElevenLabs' multilingual_v2 can't speak every language we offer.
    // Fail fast with a clear error rather than synthesize garbled / English audio.
    if matches!(plan, SynthPlan::Eleven { .. }) && !eleven_supports_lang(&peer_lang) {
        tracing::warn!(target: "voice", id, lang = %peer_lang, "ElevenLabs voice does not support this target language");
        set_stage(&app, &history, id, &stage_error("el_lang_unsupported"));
        return;
    }
    let is_eleven = matches!(plan, SynthPlan::Eleven { .. });
    let pcm_result = match plan {
        SynthPlan::Gemini { voice } => {
            synthesize_speech(&api_key, &transcription.translation, voice).await
        }
        SynthPlan::Eleven { voice_id, model } => {
            // `eleven_key` is `Some` here — the planner verified its presence.
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
            tracing::warn!(target: "voice", id, short = %short, error = %e, "voice_record: synthesize failed");
            set_stage(&app, &history, id, &stage_error(short));
            return;
        }
    };
    tracing::info!(target: "voice", id, samples = pcm.len(), "synthesis OK");

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

    // The Gemini voice arrives from JS (`tts_voice`); the provider + cloned voice
    // id come from settings (the single server-side source of truth).
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
    target_lang: Option<String>,
) -> Result<(), String> {
    // Re-target if a new language was supplied (the card was retried after the
    // user changed the language pair): persist it on the row FIRST so the new
    // target is what the pipeline below reads from `rec.target_lang` — and what a
    // future retry reuses. `None` keeps the existing target (a plain re-attempt).
    if let Some(lang) = target_lang {
        state
            .history
            .update_voice(
                id,
                VoiceUpdate {
                    target_lang: Some(lang),
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
    }

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
        // Neither the voice nor the provider is stored per-row; read the current
        // settings (same source the record command uses).
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

/// Fetch a single call record by id, with the **full** transcript.
///
/// [`history_list_calls`] returns only a truncated transcript preview for the
/// list view; this loads the complete transcript for the detail view.
#[tauri::command]
pub fn history_get_call(state: State<'_, AppState>, id: i64) -> Result<Option<CallRecord>, String> {
    state.history.get_call(id).map_err(|e| e.to_string())
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

#[cfg(test)]
mod synth_plan_tests {
    use super::*;

    fn synth(provider: TtsProvider, voice_id: &str) -> OutSynth {
        OutSynth {
            provider,
            gemini_voice: "Kore".into(),
            eleven_voice_id: voice_id.into(),
            eleven_model_id: ELEVEN_MODEL_ID,
        }
    }

    #[test]
    fn gemini_provider_plans_gemini() {
        let s = synth(TtsProvider::Gemini, "");
        assert!(matches!(plan_out_synth(&s, false), SynthPlan::Gemini { voice } if voice == "Kore"));
        // Gemini ignores ElevenLabs key/voice presence entirely.
        assert!(matches!(plan_out_synth(&s, true), SynthPlan::Gemini { .. }));
    }

    #[test]
    fn elevenlabs_without_key_fails_no_key() {
        let s = synth(TtsProvider::Elevenlabs, "v1");
        assert!(matches!(plan_out_synth(&s, false), SynthPlan::Fail("el_no_key")));
    }

    #[test]
    fn elevenlabs_without_voice_fails_no_voice() {
        let s = synth(TtsProvider::Elevenlabs, "  ");
        assert!(matches!(plan_out_synth(&s, true), SynthPlan::Fail("el_no_voice")));
    }

    #[test]
    fn elevenlabs_ready_plans_eleven() {
        let s = synth(TtsProvider::Elevenlabs, "v1");
        assert!(matches!(
            plan_out_synth(&s, true),
            SynthPlan::Eleven { voice_id, model }
                if voice_id == "v1" && model == ELEVEN_MODEL_ID
        ));
    }
}
