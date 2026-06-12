//! Live translation controller — the OUT pipeline (mic → Gemini → playback).
//!
//! This task wires only the OUT direction (my speech translated into the peer's
//! language and played into the virtual cable, or — in wizard test mode — into
//! my own headphones). The IN pipeline (peer audio → my language) and ducking
//! land in Task 11; [`LiveController`] holds its handles in `Option`s so adding
//! the IN side is purely additive.
//!
//! ## Runtime bridging (read before touching)
//! * [`crate::gemini::live::LiveSession::spawn`] calls `tokio::spawn` internally,
//!   so it MUST be invoked from inside the tokio runtime. [`LiveController::start`]
//!   is a synchronous function (called from a sync Tauri command), so it wraps
//!   every runtime-touching step (`LiveSession::spawn`, the event/level tasks)
//!   with `tauri::async_runtime::block_on` / `tauri::async_runtime::spawn`, which
//!   target Tauri's shared multi-thread runtime.
//! * The audio bridge (mic → resample → chunk → session) is a plain
//!   `std::thread` because it consumes a crossbeam (blocking) channel and uses
//!   `LiveSession::blocking_send_audio`; it must not occupy an async worker.
//! * [`LiveController::stop`] is callable from a sync Tauri command. It uses
//!   `tauri::async_runtime::block_on(session.stop())` to flush the WS close.
//!   Tauri runs sync commands on a dedicated thread (NOT an async worker), so
//!   this `block_on` does not nest a runtime and cannot deadlock. The stop order
//!   is: signal flag → stop the source (mic) → stop the session → join the
//!   bridge thread → stop playback, i.e. sources die before sinks.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::audio::capture::{start_capture, CaptureSource};
use crate::audio::dsp::{f32_to_i16, Chunker, StreamResampler};
use crate::audio::devices::cable_render_device_id;
use crate::audio::playback::start_playback;
use crate::gemini::live::{LiveSession, LiveSessionConfig, SessionEvent};

/// Capture sample rate of the mic engine (mono f32, 48 kHz).
const CAPTURE_RATE: usize = 48000;
/// Rate Gemini expects on the wire (16 kHz mono PCM16).
const SEND_RATE: usize = 16000;
/// Chunk size handed to the session: 100 ms of 16 kHz PCM16.
const SEND_CHUNK: usize = SEND_RATE / 10;
/// How long the bridge thread blocks on a mic block before re-checking `stop`.
const BRIDGE_RECV_TIMEOUT: Duration = Duration::from_millis(200);
/// Level-meter tick interval.
const LEVELS_TICK: Duration = Duration::from_millis(100);

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

/// A running live session. Drop or [`stop`](LiveController::stop) to tear down.
pub struct LiveController {
    /// Set to signal every owned thread/task to wind down.
    stop_flag: Arc<AtomicBool>,
    /// OUT-direction Gemini session. `Option` so `stop` can `take` it.
    session_out: Option<LiveSession>,
    /// OUT mic capture. `Option` so `stop` can `take` and join it.
    mic: Option<crate::audio::capture::CaptureHandle>,
    /// OUT translated-audio playback. `Option` so `stop` can `take` and join it.
    playback_out: Option<crate::audio::playback::PlaybackHandle>,
    /// Mic → session bridge thread join handle.
    bridge_join: Option<std::thread::JoinHandle<()>>,
}

impl LiveController {
    /// Start the OUT pipeline. Synchronous: safe to call from a sync command.
    ///
    /// Emits `live:state {phase:"connecting", ...}` immediately, then spawns the
    /// session, the audio bridge thread, the session-events task, and the level
    /// meter task. Returns once all are running (the session connects async).
    pub fn start(app: AppHandle, api_key: String, cfg: LiveConfig) -> anyhow::Result<Self> {
        let stop_flag = Arc::new(AtomicBool::new(false));

        // 0. Tell the UI we're spinning up before any (potentially slow) device
        //    or socket work.
        let _ = app.emit(
            "live:state",
            serde_json::json!({
                "phase": "connecting",
                "outSession": "connecting",
                "inSession": "off",
            }),
        );

        // 1. Resolve the OUT playback device (cable, or user device in test mode).
        let out_device = resolve_out_device(cfg.test_mode, cfg.output_id.clone(), cable_render_device_id())?;

        // 2. Start the mic capture. Gemini wants 16 kHz; playback resamples the
        //    24 kHz reply up to its 48 kHz render rate internally, so playback's
        //    `src_rate` is 24000.
        let mic = start_capture(CaptureSource::Mic {
            device_id: cfg.mic_id.clone(),
        })?;

        // 3. Start playback for the translated reply (24 kHz mono PCM16 in).
        let playback = start_playback(out_device, 24000)?;

        // 4. Spawn the OUT Gemini session from inside the tokio runtime.
        let (session, events) = tauri::async_runtime::block_on(async {
            LiveSession::spawn(LiveSessionConfig {
                endpoint: None,
                api_key,
                target_lang: cfg.peer_lang.clone(),
                echo: cfg.echo_target_language,
                label: "out",
            })
        });

        // 5. Audio bridge thread: mic (48 kHz f32) → 16 kHz → i16 → 100 ms chunks
        //    → session. Plain std::thread because it consumes a crossbeam channel
        //    and uses blocking_send_audio.
        let bridge_join = Self::spawn_bridge(
            app.clone(),
            stop_flag.clone(),
            mic.rx.clone(),
            session.clone(),
        );

        // 6. Session-events task: route audio to playback and transcripts/state
        //    to the UI.
        Self::spawn_events(app.clone(), stop_flag.clone(), events, playback.tx.clone());

        // 7. Level-meter task.
        Self::spawn_levels(app, stop_flag.clone(), mic.level_db_x100.clone());

        Ok(Self {
            stop_flag,
            session_out: Some(session),
            mic: Some(mic),
            playback_out: Some(playback),
            bridge_join: Some(bridge_join),
        })
    }

    /// Spawn the mic → session bridge thread. Returns its join handle.
    fn spawn_bridge(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        rx: crossbeam_channel::Receiver<Vec<f32>>,
        session: LiveSession,
    ) -> std::thread::JoinHandle<()> {
        std::thread::Builder::new()
            .name("out-bridge".to_string())
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
                            // The capture source died (mic unplugged). Tell the UI
                            // and stop bridging.
                            let _ = app.emit(
                                "live:state",
                                serde_json::json!({
                                    "phase": "error",
                                    "outSession": "source_lost",
                                    "inSession": "off",
                                }),
                            );
                            break;
                        }
                    }
                }
            })
            .expect("failed to spawn out-bridge thread")
    }

    /// Spawn the session-events task (Tauri async runtime).
    fn spawn_events(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        mut events: tokio::sync::mpsc::Receiver<SessionEvent>,
        playback_tx: crossbeam_channel::Sender<Vec<i16>>,
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
                                "direction": "out",
                                "kind": "original",
                                "text": text,
                            }),
                        );
                    }
                    SessionEvent::OutputTranscript(text) => {
                        let _ = app.emit(
                            "live:transcript",
                            serde_json::json!({
                                "direction": "out",
                                "kind": "translated",
                                "text": text,
                            }),
                        );
                    }
                    SessionEvent::Connected => {
                        let _ = app.emit("live:state", state_payload("running", "running"));
                    }
                    SessionEvent::Reconnecting => {
                        let _ = app.emit("live:state", state_payload("running", "reconnecting"));
                    }
                    SessionEvent::Failed(reason) => {
                        let _ = app.emit("live:state", state_payload("error", &reason));
                        // Terminal — no further events will arrive.
                        break;
                    }
                    SessionEvent::TurnComplete => {}
                }
            }
        });
    }

    /// Spawn the level-meter task (Tauri async runtime).
    fn spawn_levels(
        app: AppHandle,
        stop_flag: Arc<AtomicBool>,
        level_db_x100: Arc<std::sync::atomic::AtomicI32>,
    ) {
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(LEVELS_TICK);
            while !stop_flag.load(Ordering::Relaxed) {
                tick.tick().await;
                let mic_db = level_db_x100.load(Ordering::Relaxed) as f32 / 100.0;
                let _ = app.emit(
                    "live:levels",
                    serde_json::json!({
                        "micDb": mic_db,
                        // IN pipeline + ducking land in Task 11; report floor for now.
                        "appDb": -120.0,
                        "outDb": -120.0,
                    }),
                );
            }
        });
    }

    /// Tear down the session. Callable from a sync Tauri command.
    ///
    /// Order: signal stop → stop the source (mic) first so no more audio is
    /// captured → flush the session close → join the bridge thread → stop
    /// playback. Sources die before sinks.
    pub fn stop(mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);

        // Stop the source first: no more captured audio enters the bridge.
        if let Some(mic) = self.mic.take() {
            mic.stop();
        }

        // Flush the WS close. Tauri runs sync commands on a dedicated thread (not
        // an async worker), so this block_on does not nest a runtime.
        if let Some(session) = self.session_out.take() {
            tauri::async_runtime::block_on(async move {
                session.stop().await;
            });
        }

        // Join the bridge thread: the mic channel is now disconnected and the
        // stop flag is set, so it exits promptly.
        if let Some(join) = self.bridge_join.take() {
            let _ = join.join();
        }

        // Finally stop the sink.
        if let Some(playback) = self.playback_out.take() {
            playback.stop();
        }
    }
}

impl Drop for LiveController {
    fn drop(&mut self) {
        // If `stop` was not called explicitly, still signal the owned tasks and
        // threads to wind down. The handles' own `Drop` impls signal their
        // engine threads; we just join the bridge here so it doesn't outlive us.
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(join) = self.bridge_join.take() {
            let _ = join.join();
        }
    }
}

/// Build a `live:state` payload for the OUT session. `phase` is the overall
/// phase ("running" | "error"); `out_session` is the OUT session status string
/// ("running" | "reconnecting" | an error message). IN is always "off" here.
fn state_payload(phase: &str, out_session: &str) -> serde_json::Value {
    serde_json::json!({
        "phase": phase,
        "outSession": out_session,
        "inSession": "off",
    })
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
    fn state_payload_shape() {
        let v = state_payload("running", "reconnecting");
        assert_eq!(v["phase"], "running");
        assert_eq!(v["outSession"], "reconnecting");
        assert_eq!(v["inSession"], "off");
    }

    #[test]
    fn send_chunk_is_100ms_of_16k() {
        // Guards the constants: 100 ms of 16 kHz mono == 1600 samples.
        assert_eq!(SEND_CHUNK, 1600);
    }
}
