//! Voice-message pipeline: file naming, the in-app recorder, and the async
//! stage machine that drives a dropped-in or recorded clip through
//! transcribe → translate → (for recordings) synthesize.
//!
//! The Tauri commands themselves live in [`crate::ipc`]; this module owns the
//! pure helpers (file naming, stage strings, the too-short threshold) and the
//! [`RecorderHandle`] that accumulates microphone audio between
//! `voice_record_start` and `voice_record_stop`. Keeping the stage names and
//! file-name builders here (TDD-covered) means the IPC layer never hand-rolls a
//! path or a magic string.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use crate::audio::capture::{start_capture, CaptureHandle, CaptureSource, CAPTURE_RATE};

// ── stage constants ───────────────────────────────────────────────────────────
//
// These strings are persisted in the `voice_messages.stage` column AND emitted
// verbatim in `voice:progress` events, so the frontend keys off them. They are
// the single source of truth — never inline a stage literal elsewhere.

/// Freshly inserted, no work started yet.
pub const STAGE_PENDING: &str = "pending";
/// Audio is being sent to Gemini for transcription+translation.
pub const STAGE_TRANSCRIBING: &str = "transcribing";
/// Translation done; TTS in flight (recordings only).
pub const STAGE_SYNTHESIZING: &str = "synthesizing";
/// All work finished successfully.
pub const STAGE_DONE: &str = "done";

/// Build the `error:<short>` stage string for a failed pipeline run.
///
/// The frontend splits on the first `:` to show a localized error and the raw
/// short code. Keep `short` terse and machine-friendly (e.g. `no_api_key`).
pub fn stage_error(short: &str) -> String {
    format!("error:{short}")
}

// ── file-name builders ────────────────────────────────────────────────────────

/// Name of the on-disk source file for voice row `id` with extension `ext`
/// (no leading dot). Imported clips keep their original extension; recordings
/// use `wav`.
pub fn source_file_name(id: i64, ext: &str) -> String {
    format!("{id}-source.{ext}")
}

/// Name of the on-disk translated-audio file for voice row `id`.
///
/// Always the Opus/Ogg extension produced by [`crate::voice::codec::VOICE_EXT`]
/// — recordings synthesize a translated `.ogg` that is the draggable artifact.
pub fn translated_file_name(id: i64) -> String {
    format!("{id}-translated.{}", crate::voice::codec::VOICE_EXT)
}

// ── recording duration limits ──────────────────────────────────────────────────

/// Hard cap on recording length: 5 minutes of mono 48 kHz f32 samples.
/// Beyond this the accumulator stops accepting new blocks.
pub const MAX_RECORD_SAMPLES: usize = 5 * 60 * CAPTURE_RATE; // 14_400_000

/// Minimum accepted recording length, in seconds. Shorter clips are rejected
/// (`too_short`) — there's nothing to transcribe and Gemini bills the call.
pub const MIN_RECORD_SECS: f32 = 0.5;

/// True if `n_samples` of mono 48 kHz audio is too short to bother sending.
///
/// Pure so it can be unit-tested at the exact threshold boundary.
pub fn is_too_short(n_samples: usize) -> bool {
    (n_samples as f32 / CAPTURE_RATE as f32) < MIN_RECORD_SECS
}

// ── recorder ───────────────────────────────────────────────────────────────────

/// A running in-app microphone recording.
///
/// Owns the [`CaptureHandle`] (whose drop stops the WASAPI thread) and a
/// background "accumulator" thread that drains the capture channel into a
/// shared buffer of mono 48 kHz f32 samples, capped at [`MAX_RECORD_SAMPLES`].
/// [`stop`](RecorderHandle::stop) tears both down and returns the buffer.
pub struct RecorderHandle {
    capture: Option<CaptureHandle>,
    buffer: Arc<Mutex<Vec<f32>>>,
    drain_stop: Arc<AtomicBool>,
    drain_join: Option<std::thread::JoinHandle<()>>,
    started: Instant,
}

impl RecorderHandle {
    /// Start capturing from `mic_id` (or the default mic when `None`) and spawn
    /// the accumulator thread. Returns once the capture stream is live.
    pub fn start(mic_id: Option<String>) -> anyhow::Result<Self> {
        let capture = start_capture(CaptureSource::Mic { device_id: mic_id })?;

        let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let drain_stop = Arc::new(AtomicBool::new(false));

        let rx = capture.rx.clone();
        let thread_buffer = Arc::clone(&buffer);
        let thread_stop = Arc::clone(&drain_stop);

        let drain_join = std::thread::Builder::new()
            .name("voice-accumulator".to_string())
            .spawn(move || {
                while !thread_stop.load(Ordering::Relaxed) {
                    // Time-bounded recv so the stop flag is polled promptly even
                    // when no audio is arriving.
                    match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                        Ok(block) => {
                            let mut buf = thread_buffer.lock().unwrap();
                            if buf.len() >= MAX_RECORD_SAMPLES {
                                // Hard cap reached — drop further audio silently.
                                continue;
                            }
                            let room = MAX_RECORD_SAMPLES - buf.len();
                            if block.len() <= room {
                                buf.extend_from_slice(&block);
                            } else {
                                buf.extend_from_slice(&block[..room]);
                            }
                        }
                        // Timeout → loop and re-check stop. Disconnect → source
                        // died; keep what we have and exit.
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })?;

        Ok(Self {
            capture: Some(capture),
            buffer,
            drain_stop,
            drain_join: Some(drain_join),
            started: Instant::now(),
        })
    }

    /// Elapsed wall-clock time since the recording started.
    pub fn elapsed(&self) -> std::time::Duration {
        self.started.elapsed()
    }

    /// Stop capture and the accumulator, returning the buffered mono 48 kHz
    /// samples.
    pub fn stop(mut self) -> Vec<f32> {
        // Stop the WASAPI capture first (joins its thread), then signal and join
        // the accumulator so it sees the channel disconnect / stop flag.
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        self.drain_stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.drain_join.take() {
            let _ = join.join();
        }
        let buf = self.buffer.lock().unwrap();
        buf.clone()
    }
}

impl Drop for RecorderHandle {
    fn drop(&mut self) {
        // Best-effort teardown if a handle is dropped without `stop()` (e.g. a
        // panic). Never block-join here beyond what the threads need.
        self.drain_stop.store(true, Ordering::Relaxed);
        if let Some(capture) = self.capture.take() {
            capture.stop();
        }
        if let Some(join) = self.drain_join.take() {
            let _ = join.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_file_name_keeps_ext() {
        assert_eq!(source_file_name(7, "ogg"), "7-source.ogg");
        assert_eq!(source_file_name(42, "wav"), "42-source.wav");
        assert_eq!(source_file_name(1, "mp3"), "1-source.mp3");
    }

    #[test]
    fn translated_file_name_is_ogg() {
        assert_eq!(translated_file_name(7), "7-translated.ogg");
        // Stays in lockstep with the codec's chosen container extension.
        assert!(translated_file_name(3).ends_with(crate::voice::codec::VOICE_EXT));
    }

    #[test]
    fn stage_constants_roundtrip() {
        // The persisted/emitted strings must be exactly these.
        assert_eq!(STAGE_PENDING, "pending");
        assert_eq!(STAGE_TRANSCRIBING, "transcribing");
        assert_eq!(STAGE_SYNTHESIZING, "synthesizing");
        assert_eq!(STAGE_DONE, "done");
    }

    #[test]
    fn stage_error_formats_and_parses() {
        let s = stage_error("no_api_key");
        assert_eq!(s, "error:no_api_key");
        // Frontend split-on-first-colon contract.
        let (head, short) = s.split_once(':').unwrap();
        assert_eq!(head, "error");
        assert_eq!(short, "no_api_key");
    }

    #[test]
    fn too_short_threshold_boundary() {
        // 48_000 samples == exactly 1.0 s → not too short.
        assert!(!is_too_short(CAPTURE_RATE));
        // Exactly the 0.5 s threshold (24_000 samples) is accepted (>= 0.5).
        let half = (CAPTURE_RATE as f32 * MIN_RECORD_SECS) as usize;
        assert!(!is_too_short(half));
        // One sample below the threshold is rejected.
        assert!(is_too_short(half - 1));
        // Empty buffer is always too short.
        assert!(is_too_short(0));
    }

    #[test]
    fn max_record_samples_is_five_minutes() {
        assert_eq!(MAX_RECORD_SAMPLES, 14_400_000);
        assert_eq!(MAX_RECORD_SAMPLES, 5 * 60 * 48_000);
    }
}
