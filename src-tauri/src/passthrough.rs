//! Idle microphone passthrough.
//!
//! When no live translation session is running, this pipes the raw microphone
//! straight into the VB-CABLE render endpoint so the peer's call app (whose mic
//! is set to "CABLE Output") still hears the user's *original* voice instead of
//! silence. It lets the user leave the call app's microphone permanently set to
//! the cable, with no device switching between translated and untranslated talk.
//!
//! It is deliberately tiny: one mic capture, one render to the cable, and a
//! bridge thread that forwards 48 kHz mono blocks (as PCM16) from one to the
//! other. No Gemini, no API key, no resampling beyond playback's internal pass.
//! [`LiveController`](crate::live_ctrl::LiveController) owns the mic + cable
//! while a session runs, so the caller must stop the passthrough before starting
//! a session and may restart it after the session stops.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use crate::audio::capture::{start_capture, CaptureHandle, CaptureSource};
use crate::audio::dsp::f32_to_i16;
use crate::audio::playback::{start_playback, PlaybackHandle, RENDER_RATE};

/// How long the bridge blocks on a capture block before re-checking `stop`.
const BRIDGE_RECV_TIMEOUT: Duration = Duration::from_millis(200);

/// A running mic → cable passthrough. Drop or [`stop`](Passthrough::stop) to end.
pub struct Passthrough {
    stop: Arc<AtomicBool>,
    mic: Option<CaptureHandle>,
    playback: Option<PlaybackHandle>,
    bridge: Option<std::thread::JoinHandle<()>>,
}

impl Passthrough {
    /// Start capturing `mic_id` (or the default mic) and rendering it into the
    /// cable render endpoint `cable_id`. The mic engine emits 48 kHz mono f32;
    /// playback's source rate is therefore [`RENDER_RATE`] (a 1:1 pass).
    pub fn start(mic_id: Option<String>, cable_id: String) -> anyhow::Result<Self> {
        let mic = start_capture(CaptureSource::Mic { device_id: mic_id })?;
        // No default fallback: this is the VB-CABLE sink, never the speakers.
        let playback = start_playback(Some(cable_id), RENDER_RATE, false)?;

        let stop = Arc::new(AtomicBool::new(false));
        let rx = mic.rx.clone();
        let tx = playback.tx.clone();
        let thread_stop = Arc::clone(&stop);

        let bridge = std::thread::Builder::new()
            .name("passthrough-bridge".to_string())
            .spawn(move || {
                while !thread_stop.load(Ordering::Relaxed) {
                    match rx.recv_timeout(BRIDGE_RECV_TIMEOUT) {
                        Ok(block) => {
                            // Drop on backpressure — never block the capture path.
                            let _ = tx.try_send(f32_to_i16(&block));
                        }
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })?;

        Ok(Self {
            stop,
            mic: Some(mic),
            playback: Some(playback),
            bridge: Some(bridge),
        })
    }

    /// Stop the passthrough: signal, stop the mic (joins capture), join the
    /// bridge, then stop the cable playback. Source before sink.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(mic) = self.mic.take() {
            mic.stop();
        }
        if let Some(join) = self.bridge.take() {
            let _ = join.join();
        }
        if let Some(playback) = self.playback.take() {
            playback.stop();
        }
    }
}

impl Drop for Passthrough {
    fn drop(&mut self) {
        // Best-effort teardown if dropped without `stop()`.
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.bridge.take() {
            let _ = join.join();
        }
    }
}
