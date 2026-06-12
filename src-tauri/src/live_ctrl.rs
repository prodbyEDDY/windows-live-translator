//! Live translation controller — the OUT and IN pipelines plus ducking.
//!
//! * **OUT**: my mic → Gemini (peer's language) → the virtual cable (or, in
//!   wizard test mode, my own headphones).
//! * **IN** (Task 11): the peer app's / system render audio → Gemini (my
//!   language) → my headphones, with the peer app's volume *ducked* while a
//!   translation is audible.
//!
//! [`LiveController`] holds every handle in an `Option` so `stop`/`Drop` can
//! `take` and tear them down in a precise order.
//!
//! ## Runtime bridging (read before touching)
//! * [`crate::gemini::live::LiveSession::spawn`] calls `tokio::spawn` internally,
//!   so it MUST be invoked from inside the tokio runtime. [`LiveController::start`]
//!   is a synchronous function (called from a sync Tauri command), so it wraps
//!   every runtime-touching step (`LiveSession::spawn`, the event/level tasks)
//!   with `tauri::async_runtime::block_on` / `tauri::async_runtime::spawn`, which
//!   target Tauri's shared multi-thread runtime.
//! * Each audio bridge (capture → resample → chunk → session) is a plain
//!   `std::thread` because it consumes a crossbeam (blocking) channel and uses
//!   `LiveSession::blocking_send_audio`; it must not occupy an async worker.
//! * **Ducking lives on its own `std::thread`** (`ducking`): the
//!   [`crate::audio::ducking::DuckGuard`] holds `!Send` COM pointers and must be
//!   created *and* dropped on a single thread. That thread polls the IN
//!   playback's `queued_samples` and creates/drops the guard accordingly; on
//!   stop it drops any live guard (restoring volumes) before exiting, and the
//!   controller joins it *after* signalling stop so volumes are always restored.
//! * [`LiveController::stop`] is callable from a sync Tauri command. It uses
//!   `tauri::async_runtime::block_on(session.stop())` to flush the WS close.
//!   Tauri runs sync commands on a dedicated thread (NOT an async worker), so
//!   this `block_on` does not nest a runtime and cannot deadlock. Stop order:
//!   signal flag → stop the sources (IN capture, mic) → stop both sessions →
//!   join both bridges + the ducking thread → stop both playbacks. Sources die
//!   before sinks; the ducking thread joins after its guard is dropped.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::capture::{start_capture, CaptureSource};
use crate::audio::dsp::{f32_to_i16, Chunker, StreamResampler};
use crate::audio::devices::cable_render_device_id;
use crate::audio::ducking::DuckGuard;
use crate::audio::playback::start_playback;
use crate::gemini::live::{LiveSession, LiveSessionConfig, SessionEvent};

/// Capture sample rate of the mic engine (mono f32, 48 kHz).
const CAPTURE_RATE: usize = 48000;
/// Rate Gemini expects on the wire (16 kHz mono PCM16).
const SEND_RATE: usize = 16000;
/// Chunk size handed to the session: 100 ms of 16 kHz PCM16.
const SEND_CHUNK: usize = SEND_RATE / 10;
/// How long the bridge thread blocks on a capture block before re-checking `stop`.
const BRIDGE_RECV_TIMEOUT: Duration = Duration::from_millis(200);
/// Level-meter tick interval.
const LEVELS_TICK: Duration = Duration::from_millis(100);
/// Ducking thread poll interval.
const DUCK_TICK: Duration = Duration::from_millis(50);
/// Consecutive idle ducking ticks (queue empty) before releasing the duck.
/// 8 ticks × 50 ms = 400 ms of silence before the peer's volume comes back.
const DUCK_RELEASE_TICKS: u32 = 8;
/// Restore-file name under the app-data dir (read at startup for crash recovery).
pub const DUCK_RESTORE_FILE: &str = "duck-restore.json";

/// Configuration for a live session, sent from the frontend as a JSON object.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    pub my_lang: String,
    pub peer_lang: String,
    pub mic_id: Option<String>,
    pub output_id: Option<String>,
    /// "app" | "system" — drives the IN capture source (Task 11). Unused here.
    pub capture_mode: String,
    pub app_pid: Option<u32>,
    pub echo_target_language: bool,
    pub ducking_enabled: bool,
    pub duck_level: f32,
    /// Wizard test mode: OUT translation plays into the user's own output
    /// device (`output_id`) instead of the virtual cable, and the IN pipeline is
    /// skipped. Lets the user hear their own translated voice before a real call.
    pub test_mode: bool,
}

/// Resolve the OUT playback device id from the config and the detected cable.
///
/// Pure helper so the test_mode / cable-presence branching is unit-testable
/// without audio hardware:
/// * `test_mode` → play the translation into the user's chosen output device
///   (`output_id`; `None` means the system default render device).
/// * otherwise → play into the VB-CABLE render endpoint so the translated voice
///   reaches the call. A missing cable is a hard error (`"cable_missing"`).
fn resolve_out_device(
    test_mode: bool,
    output_id: Option<String>,
    cable_id: Option<String>,
) -> anyhow::Result<Option<String>> {
    if test_mode {
        Ok(output_id)
    } else {
        let id = cable_id.ok_or_else(|| anyhow::anyhow!("cable_missing"))?;
        Ok(Some(id))
    }
}

/// Resolve the IN capture source from the config's `capture_mode`.
///
/// Pure helper so the mode/pid branching is unit-testable without audio
/// hardware:
/// * `"app"` → loopback-capture a single process; requires `app_pid`
///   (`"no_app_selected"` otherwise).
/// * `"system"` → capture all system render audio except our own process.
/// * anything else → `"bad_capture_mode"`.
fn resolve_in_source(mode: &str, pid: Option<u32>) -> anyhow::Result<CaptureSource> {
    match mode {
        "app" => {
            let pid = pid.ok_or_else(|| anyhow::anyhow!("no_app_selected"))?;
            Ok(CaptureSource::App { pid })
        }
        "system" => Ok(CaptureSource::SystemExcludeSelf),
        _ => Err(anyhow::anyhow!("bad_capture_mode")),
    }
}

/// Per-direction session status, shared between the two event tasks. Each event
/// task mutates only its own field, then emits the whole struct as `live:state`.
///
/// A field value is one of: `"off"` (direction not started), `"connecting"`
/// (started, not yet `Connected`), `"running"`, `"reconnecting"`, or an error
/// message string (terminal failure / source loss). The overall `phase` is
/// derived in [`emit_state`].
#[derive(Debug, Clone)]
struct SessState {
    out: String,
    in_: String,
}

/// True when a per-direction status string represents a terminal error rather
/// than one of the known non-error states.
fn is_error_status(s: &str) -> bool {
    !matches!(
        s,
        "off" | "connecting" | "running" | "reconnecting"
    )
}

/// Compute the overall phase from the two direction statuses:
/// * `"error"` if *either* direction is in a terminal-error state,
/// * else `"connecting"` if *either* active direction is still connecting,
/// * else `"running"`.
fn compute_phase(st: &SessState) -> &'static str {
    if is_error_status(&st.out) || is_error_status(&st.in_) {
        "error"
    } else if st.out == "connecting" || st.in_ == "connecting" {
        "connecting"
    } else {
        "running"
    }
}

/// Set one direction's status slot in the shared state.
fn set_dir(st: &mut SessState, direction: &str, value: &str) {
    if direction == "in" {
        st.in_ = value.to_string();
    } else {
        st.out = value.to_string();
    }
}

/// Build the `live:state` payload from the shared state.
fn state_value(st: &SessState) -> serde_json::Value {
    serde_json::json!({
        "phase": compute_phase(st),
        "outSession": st.out,
        "inSession": st.in_,
    })
}

/// Emit the full `live:state` after updating one direction's status under lock.
/// `set` mutates the shared struct (e.g. `|s| s.out = "running".into()`); the
/// post-update snapshot is emitted while still consistent.
fn emit_state(app: &AppHandle, state: &Arc<Mutex<SessState>>, set: impl FnOnce(&mut SessState)) {
    let snapshot = {
        let mut guard = state.lock().unwrap_or_else(|p| p.into_inner());
        set(&mut guard);
        guard.clone()
    };
    let _ = app.emit("live:state", state_value(&snapshot));
}

/// A running live session. Drop or [`stop`](LiveController::stop) to tear down.
pub struct LiveController {
    /// Set to signal every owned thread/task to wind down.
    stop_flag: Arc<AtomicBool>,
    /// OUT-direction Gemini session. `Option` so `stop` can `take` it.
    session_out: Option<LiveSession>,
    /// IN-direction Gemini session. `None` in test mode (IN pipeline skipped).
    session_in: Option<LiveSession>,
    /// OUT mic capture. `Option` so `stop` can `take` and join it.
    mic: Option<crate::audio::capture::CaptureHandle>,
    /// IN capture (peer app / system render audio). `None` in test mode.
    in_capture: Option<crate::audio::capture::CaptureHandle>,
    /// OUT translated-audio playback (cable, or headphones in test mode).
    playback_out: Option<crate::audio::playback::PlaybackHandle>,
    /// IN translated-audio playback (my headphones). `None` in test mode.
    playback_in: Option<crate::audio::playback::PlaybackHandle>,
    /// OUT mic → session bridge thread join handle.
    bridge_join: Option<std::thread::JoinHandle<()>>,
    /// IN capture → session bridge thread join handle. `None` in test mode.
    in_bridge_join: Option<std::thread::JoinHandle<()>>,
    /// Ducking thread join handle. `None` in test mode (no IN audio to duck).
    ducking_join: Option<std::thread::JoinHandle<()>>,
}

impl LiveController {
    /// Start the OUT pipeline. Synchronous: safe to call from a sync command.
    ///
    /// Emits `live:state {phase:"connecting", ...}` immediately, then spawns the
    /// session, the audio bridge thread, the session-events task, and the level
    /// meter task. Returns once all are running (the session connects async).
    pub fn start(app: AppHandle, api_key: String, cfg: LiveConfig) -> anyhow::Result<Self> {
        let stop_flag = Arc::new(AtomicBool::new(false));

        // Shared per-direction status. IN starts "off" in test mode (the IN
        // pipeline is skipped), "connecting" otherwise.
        let initial = SessState {
            out: "connecting".into(),
            in_: if cfg.test_mode { "off".into() } else { "connecting".into() },
        };

        // 0. Tell the UI we're spinning up before any (potentially slow) device
        //    or socket work.
        let _ = app.emit("live:state", state_value(&initial));

        let state = Arc::new(Mutex::new(initial));

        // 1. Resolve the OUT playback device (cable, or user device in test mode).
        let out_device =
            resolve_out_device(cfg.test_mode, cfg.output_id.clone(), cable_render_device_id())?;

        // 2. Start the mic capture. Gemini wants 16 kHz; playback resamples the
        //    24 kHz reply up to its 48 kHz render rate internally, so playback's
        //    `src_rate` is 24000.
        let mic = start_capture(CaptureSource::Mic {
            device_id: cfg.mic_id.clone(),
        })?;

        // 3. Start playback for the OUT translated reply (24 kHz mono PCM16 in).
        let playback = start_playback(out_device, 24000)?;

        // 4. Spawn the OUT Gemini session from inside the tokio runtime.
        let (session, events) = tauri::async_runtime::block_on(async {
            LiveSession::spawn(LiveSessionConfig {
                endpoint: None,
                api_key: api_key.clone(),
                target_lang: cfg.peer_lang.clone(),
                echo: cfg.echo_target_language,
                label: "out",
            })
        });

        // 5. OUT audio bridge: mic (48 kHz f32) → 16 kHz → i16 → 100 ms chunks →
        //    session. Plain std::thread (consumes a crossbeam channel + uses
        //    blocking_send_audio).
        let bridge_join = Self::spawn_bridge(
            app.clone(),
            stop_flag.clone(),
            state.clone(),
            mic.rx.clone(),
            session.clone(),
            "out",
        );

        // 6. OUT session-events task: route audio to playback, transcripts/state
        //    to the UI.
        Self::spawn_events(
            app.clone(),
            stop_flag.clone(),
            state.clone(),
            events,
            playback.tx.clone(),
            "out",
        );

        // --- IN pipeline (real mode only) -----------------------------------
        // In test mode we only let the user hear their own translated voice, so
        // the IN direction (peer audio → my language) and ducking are skipped.
        let mut session_in = None;
        let mut in_capture = None;
        let mut playback_in = None;
        let mut in_bridge_join = None;
        let mut ducking_join = None;
        let mut in_level: Option<Arc<std::sync::atomic::AtomicI32>> = None;

        if !cfg.test_mode {
            // 7a. Resolve + start the IN capture source (app loopback / system).
            let in_source = resolve_in_source(&cfg.capture_mode, cfg.app_pid)?;
            let in_cap = start_capture(in_source)?;

            // 7b. IN playback → my headphones (`output_id`; None = system default).
            let pb_in = start_playback(cfg.output_id.clone(), 24000)?;

            // 7c. IN Gemini session: translate peer speech into MY language.
            let (sess_in, in_events) = tauri::async_runtime::block_on(async {
                LiveSession::spawn(LiveSessionConfig {
                    endpoint: None,
                    api_key,
                    target_lang: cfg.my_lang.clone(),
                    echo: cfg.echo_target_language,
                    label: "in",
                })
            });

            // 7d. IN audio bridge (same pattern as OUT).
            let in_join = Self::spawn_bridge(
                app.clone(),
                stop_flag.clone(),
                state.clone(),
                in_cap.rx.clone(),
                sess_in.clone(),
                "in",
            );

            // 7e. IN session-events task.
            Self::spawn_events(
                app.clone(),
                stop_flag.clone(),
                state.clone(),
                in_events,
                pb_in.tx.clone(),
                "in",
            );

            // 7f. Ducking thread (COM lives here; the guard is `!Send`). Resolve
            //     the restore-file path up front (needs the AppHandle).
            let restore_path = app
                .path()
                .app_data_dir()
                .map(|d| d.join(DUCK_RESTORE_FILE))
                .unwrap_or_else(|_| PathBuf::from(DUCK_RESTORE_FILE));
            // In app mode duck only the captured pid; in system mode duck all
            // sessions except our own (pid = None).
            let duck_pid = match cfg.capture_mode.as_str() {
                "app" => cfg.app_pid,
                _ => None,
            };
            let ducking = Self::spawn_ducking(
                stop_flag.clone(),
                pb_in.queued_samples.clone(),
                cfg.ducking_enabled,
                duck_pid,
                cfg.duck_level,
                restore_path,
            );

            in_level = Some(in_cap.level_db_x100.clone());
            session_in = Some(sess_in);
            in_capture = Some(in_cap);
            playback_in = Some(pb_in);
            in_bridge_join = Some(in_join);
            ducking_join = Some(ducking);
        }

        // 8. Level-meter task: mic (OUT) + IN capture level when present.
        Self::spawn_levels(app, stop_flag.clone(), mic.level_db_x100.clone(), in_level);

        Ok(Self {
            stop_flag,
            session_out: Some(session),
            session_in,
            mic: Some(mic),
            in_capture,
            playback_out: Some(playback),
            playback_in,
            bridge_join: Some(bridge_join),
            in_bridge_join,
            ducking_join,
        })
    }

    /// Spawn a capture → session bridge thread for `direction` ("in" | "out").
    /// Returns its join handle.
    fn spawn_bridge(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        state: Arc<Mutex<SessState>>,
        rx: crossbeam_channel::Receiver<Vec<f32>>,
        session: LiveSession,
        direction: &'static str,
    ) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name(format!("{direction}-bridge"))
            .spawn(move || {
                let mut resampler = StreamResampler::new(CAPTURE_RATE, SEND_RATE);
                let mut chunker = Chunker::new(SEND_CHUNK);

                while !stop_flag.load(Ordering::Relaxed) {
                    match rx.recv_timeout(BRIDGE_RECV_TIMEOUT) {
                        Ok(block) => {
                            let down = resampler.push(&block);
                            if down.is_empty() {
                                continue;
                            }
                            let pcm16 = f32_to_i16(&down);
                            for chunk in chunker.push(&pcm16) {
                                session.blocking_send_audio(chunk);
                            }
                        }
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                            // The capture source died (mic unplugged / app gone).
                            // Mark this direction's status and emit; the other
                            // direction keeps running.
                            emit_state(&app, &state, |s| {
                                let slot = if direction == "in" { &mut s.in_ } else { &mut s.out };
                                *slot = "source_lost".into();
                            });
                            break;
                        }
                    }
                }
            })
            .unwrap_or_else(|_| panic!("failed to spawn {direction}-bridge thread"))
    }

    /// Spawn a session-events task for `direction` ("in" | "out") on the Tauri
    /// async runtime. Routes audio to the matching playback and transcripts /
    /// state to the UI, updating this direction's slot in the shared state.
    fn spawn_events(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        state: Arc<Mutex<SessState>>,
        mut events: tokio::sync::mpsc::Receiver<SessionEvent>,
        playback_tx: crossbeam_channel::Sender<Vec<i16>>,
        direction: &'static str,
    ) {
        tauri::async_runtime::spawn(async move {
            while !stop_flag.load(Ordering::Relaxed) {
                let Some(ev) = events.recv().await else {
                    break;
                };
                match ev {
                    SessionEvent::Audio(pcm) => {
                        // Drop on backpressure — playback is bursty and the render
                        // thread must never be blocked by us.
                        let _ = playback_tx.try_send(pcm);
                    }
                    SessionEvent::InputTranscript(text) => {
                        let _ = app.emit(
                            "live:transcript",
                            serde_json::json!({
                                "direction": direction,
                                "kind": "original",
                                "text": text,
                            }),
                        );
                    }
                    SessionEvent::OutputTranscript(text) => {
                        let _ = app.emit(
                            "live:transcript",
                            serde_json::json!({
                                "direction": direction,
                                "kind": "translated",
                                "text": text,
                            }),
                        );
                    }
                    SessionEvent::Connected => {
                        emit_state(&app, &state, |s| {
                            set_dir(s, direction, "running");
                        });
                    }
                    SessionEvent::Reconnecting => {
                        emit_state(&app, &state, |s| {
                            set_dir(s, direction, "reconnecting");
                        });
                    }
                    SessionEvent::Failed(reason) => {
                        emit_state(&app, &state, |s| {
                            set_dir(s, direction, &reason);
                        });
                        // Terminal — no further events will arrive.
                        break;
                    }
                    SessionEvent::TurnComplete => {}
                }
            }
        });
    }

    /// Spawn the level-meter task (Tauri async runtime). Emits the OUT mic level
    /// (`micDb`) and, when present, the IN capture level (`appDb`). `outDb`
    /// stays at the floor (no render-side meter yet).
    fn spawn_levels(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        mic_level_db_x100: Arc<std::sync::atomic::AtomicI32>,
        in_level_db_x100: Option<Arc<std::sync::atomic::AtomicI32>>,
    ) {
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(LEVELS_TICK);
            while !stop_flag.load(Ordering::Relaxed) {
                tick.tick().await;
                let mic_db = mic_level_db_x100.load(Ordering::Relaxed) as f32 / 100.0;
                let app_db = match &in_level_db_x100 {
                    Some(l) => l.load(Ordering::Relaxed) as f32 / 100.0,
                    None => -120.0,
                };
                let _ = app.emit(
                    "live:levels",
                    serde_json::json!({
                        "micDb": mic_db,
                        "appDb": app_db,
                        // No render-side meter yet; keep the floor for outDb.
                        "outDb": -120.0,
                    }),
                );
            }
        });
    }

    /// Spawn the ducking thread. COM lives entirely on this thread because the
    /// [`DuckGuard`] holds `!Send` COM pointers and must be created *and* dropped
    /// here.
    ///
    /// Polls the IN playback's `queued_samples` every [`DUCK_TICK`]:
    /// * queued > 0 and no guard yet → create a [`DuckGuard`] (ducks the peer's
    ///   volume; writes the restore file first).
    /// * queued == 0 for [`DUCK_RELEASE_TICKS`] consecutive ticks → drop the
    ///   guard (ramps volume back up, clears the restore file).
    /// * stop flag set → drop any live guard (restoring) and exit.
    ///
    /// A `DuckGuard::duck` failure is logged and retried on the next active
    /// tick; it never tears down the session.
    fn spawn_ducking(
        stop_flag: Arc<AtomicBool>,
        queued_samples: Arc<std::sync::atomic::AtomicUsize>,
        enabled: bool,
        pid: Option<u32>,
        level: f32,
        restore_path: PathBuf,
    ) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name("ducking".to_string())
            .spawn(move || {
                let mut guard: Option<DuckGuard> = None;
                let mut idle_ticks: u32 = 0;

                while !stop_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(DUCK_TICK);
                    if !enabled {
                        continue;
                    }
                    let queued = queued_samples.load(Ordering::Relaxed);
                    if queued > 0 {
                        idle_ticks = 0;
                        if guard.is_none() {
                            match DuckGuard::duck(restore_path.clone(), pid, level) {
                                Ok(g) => guard = Some(g),
                                Err(e) => {
                                    tracing::warn!("ducking: failed to duck: {e}");
                                }
                            }
                        }
                    } else if guard.is_some() {
                        idle_ticks += 1;
                        if idle_ticks >= DUCK_RELEASE_TICKS {
                            // Drop restores volumes + clears the restore file.
                            guard = None;
                            idle_ticks = 0;
                        }
                    }
                }
                // Stop: drop any live guard so volumes are restored before exit.
                drop(guard);
            })
            .expect("failed to spawn ducking thread")
    }

    /// Tear down the session. Callable from a sync Tauri command.
    ///
    /// Order: signal stop → stop the sources (IN capture, mic) so no more audio
    /// is captured → flush both session closes → join both bridges + the ducking
    /// thread (the ducking thread drops its guard on stop, restoring volumes,
    /// *before* it joins here) → stop both playbacks. Sources die before sinks.
    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);

        // Stop the sources first: no more captured audio enters the bridges.
        if let Some(cap) = self.in_capture.take() {
            cap.stop();
        }
        if let Some(mic) = self.mic.take() {
            mic.stop();
        }

        // Flush both WS closes. Tauri runs sync commands on a dedicated thread
        // (not an async worker), so this block_on does not nest a runtime.
        let session_out = self.session_out.take();
        let session_in = self.session_in.take();
        if session_out.is_some() || session_in.is_some() {
            tauri::async_runtime::block_on(async move {
                if let Some(s) = session_out {
                    s.stop().await;
                }
                if let Some(s) = session_in {
                    s.stop().await;
                }
            });
        }

        // Join both bridges: the capture channels are disconnected and the stop
        // flag is set, so they exit promptly.
        if let Some(join) = self.bridge_join.take() {
            let _ = join.join();
        }
        if let Some(join) = self.in_bridge_join.take() {
            let _ = join.join();
        }

        // Join the ducking thread last among the threads: it drops its guard on
        // the stop flag (restoring volumes + clearing the restore file) before
        // returning, so by the time this join completes volumes are back.
        if let Some(join) = self.ducking_join.take() {
            let _ = join.join();
        }

        // Finally stop the sinks.
        if let Some(playback) = self.playback_out.take() {
            playback.stop();
        }
        if let Some(playback) = self.playback_in.take() {
            playback.stop();
        }
    }
}

impl Drop for LiveController {
    fn drop(&mut self) {
        // If `stop` was not called explicitly, still signal the owned tasks and
        // threads to wind down. The handles' own `Drop` impls signal their
        // engine threads; we join the bridges + ducking thread here so they
        // don't outlive us (the ducking thread restores volumes on stop).
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(join) = self.bridge_join.take() {
            let _ = join.join();
        }
        if let Some(join) = self.in_bridge_join.take() {
            let _ = join.join();
        }
        if let Some(join) = self.ducking_join.take() {
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_out_device_test_mode_uses_output_id() {
        // test_mode: the user's chosen output device is used verbatim, and the
        // cable's presence is irrelevant.
        let got = resolve_out_device(true, Some("dev-7".into()), Some("cable-id".into())).unwrap();
        assert_eq!(got, Some("dev-7".into()));

        // test_mode with no output_id → None (system default render device).
        let got = resolve_out_device(true, None, None).unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn resolve_out_device_live_mode_requires_cable() {
        // Live mode: the cable id wins regardless of output_id.
        let got =
            resolve_out_device(false, Some("ignored".into()), Some("cable-id".into())).unwrap();
        assert_eq!(got, Some("cable-id".into()));

        // Live mode with no cable → hard error mapped to "cable_missing".
        let err = resolve_out_device(false, Some("ignored".into()), None).unwrap_err();
        assert_eq!(err.to_string(), "cable_missing");
    }

    #[test]
    fn resolve_in_source_app_requires_pid() {
        // "app" with a pid → App loopback of that pid.
        match resolve_in_source("app", Some(4242)).unwrap() {
            CaptureSource::App { pid } => assert_eq!(pid, 4242),
            other => panic!("expected App, got {other:?}"),
        }
        // "app" without a pid → "no_app_selected".
        let err = resolve_in_source("app", None).unwrap_err();
        assert_eq!(err.to_string(), "no_app_selected");
    }

    #[test]
    fn resolve_in_source_system_is_exclude_self() {
        // "system" → SystemExcludeSelf (pid argument ignored).
        match resolve_in_source("system", None).unwrap() {
            CaptureSource::SystemExcludeSelf => {}
            other => panic!("expected SystemExcludeSelf, got {other:?}"),
        }
        match resolve_in_source("system", Some(99)).unwrap() {
            CaptureSource::SystemExcludeSelf => {}
            other => panic!("expected SystemExcludeSelf, got {other:?}"),
        }
    }

    #[test]
    fn resolve_in_source_bad_mode_errors() {
        let err = resolve_in_source("nonsense", Some(1)).unwrap_err();
        assert_eq!(err.to_string(), "bad_capture_mode");
        let err = resolve_in_source("", None).unwrap_err();
        assert_eq!(err.to_string(), "bad_capture_mode");
    }

    #[test]
    fn state_value_shape_and_phase() {
        // Both running → phase "running".
        let st = SessState {
            out: "running".into(),
            in_: "running".into(),
        };
        let v = state_value(&st);
        assert_eq!(v["phase"], "running");
        assert_eq!(v["outSession"], "running");
        assert_eq!(v["inSession"], "running");
    }

    #[test]
    fn phase_connecting_when_either_connecting() {
        let st = SessState {
            out: "connecting".into(),
            in_: "off".into(),
        };
        assert_eq!(compute_phase(&st), "connecting");
        let st = SessState {
            out: "running".into(),
            in_: "connecting".into(),
        };
        assert_eq!(compute_phase(&st), "connecting");
    }

    #[test]
    fn phase_error_when_either_terminal() {
        // An unknown status string (e.g. an error message / source_lost) is
        // treated as a terminal error.
        let st = SessState {
            out: "running".into(),
            in_: "source_lost".into(),
        };
        assert_eq!(compute_phase(&st), "error");
        let st = SessState {
            out: "too many reconnect attempts".into(),
            in_: "off".into(),
        };
        assert_eq!(compute_phase(&st), "error");
    }

    #[test]
    fn known_statuses_are_not_errors() {
        for s in ["off", "connecting", "running", "reconnecting"] {
            assert!(!is_error_status(s), "{s} should not be an error");
        }
        assert!(is_error_status("source_lost"));
        assert!(is_error_status("anything else"));
    }

    #[test]
    fn set_dir_targets_correct_slot() {
        let mut st = SessState {
            out: "off".into(),
            in_: "off".into(),
        };
        set_dir(&mut st, "in", "running");
        assert_eq!(st.in_, "running");
        assert_eq!(st.out, "off");
        set_dir(&mut st, "out", "reconnecting");
        assert_eq!(st.out, "reconnecting");
    }

    #[test]
    fn send_chunk_is_100ms_of_16k() {
        // Guards the constants: 100 ms of 16 kHz mono == 1600 samples.
        assert_eq!(SEND_CHUNK, 1600);
    }
}
