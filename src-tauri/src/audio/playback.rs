//! WASAPI render (playback) engine with a jitter buffer.
//!
//! [`start_playback`] spawns a dedicated thread (`audio-render`) that opens a
//! WASAPI render endpoint in shared, event-driven mode, requesting a
//! 48 kHz / f32 / stereo stream with automatic format conversion. Translated
//! speech arrives from the pipeline as bursty mono PCM16 at `src_rate`
//! (24 kHz from Gemini); it is resampled to 48 kHz, buffered, and rendered to
//! the chosen device (headphones, or the VB-CABLE virtual input).
//!
//! ## Jitter buffer
//! Gemini delivers audio in bursts with gaps between utterances. To avoid
//! underrun crackle at the start of each burst we prebuffer ~150 ms before
//! letting audio flow, writing digital silence to the device meanwhile so the
//! engine never starves. When the FIFO drains to empty mid-stream (the gap
//! between two translated utterances) we re-arm the prebuffer so the next
//! burst gets the same smoothing.
//!
//! ## wasapi 0.23 adaptation notes
//! * `StreamMode::EventsShared { autoconvert: true, .. }` is the same idiom as
//!   `capture.rs`; it enables `AUTOCONVERTPCM` internally so the engine accepts
//!   our 48 kHz/f32/stereo format regardless of the device's native mix format.
//! * The buffer size getter `get_bufferframecount` is deprecated in 0.23 in
//!   favour of `get_buffer_size`; we use the latter.
//! * `AudioClient::get_available_space_in_frames()` returns
//!   `buffer_frames - current_padding` for the shared/event configuration,
//!   i.e. exactly the writable frame count this loop needs each tick.
//! * `AudioRenderClient::write_to_device(nbr_frames, &[u8], None)` requires the
//!   byte slice length to equal `nbr_frames * bytes_per_frame` exactly
//!   (8 bytes/frame for stereo f32), else it errors with `DataLengthMismatch`.
//! * `Handle::wait_for_event` returns `Err(WasapiError::EventTimeout)` on
//!   timeout; we treat that as "no slot freed yet" and loop so the stop flag is
//!   polled at least every 200 ms.

use crossbeam_channel::{bounded, Receiver, Sender};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

use super::dsp::{i16_to_f32, StreamResampler};

/// Sample rate the render stream runs at (mono-domain; the device gets stereo).
pub const RENDER_RATE: usize = 48000;

/// Channels we request from WASAPI. Mono FIFO samples are duplicated to both.
const RENDER_CHANNELS: usize = 2;

/// Bytes per stereo f32 frame (2 channels × 4 bytes).
const BYTES_PER_FRAME: usize = RENDER_CHANNELS * 4;

/// Bounded capacity of the PCM input channel. Each burst is a `Vec<i16>`; this
/// is plenty of slack for the bursty producer without unbounded growth.
const CHANNEL_CAPACITY: usize = 64;

/// Event-wait timeout. Bounds how long the loop blocks before re-checking the
/// stop flag, so [`PlaybackHandle::stop`] joins promptly.
const EVENT_TIMEOUT_MS: u32 = 200;

/// Jitter prebuffer target: ~150 ms of 48 kHz audio before a burst starts
/// playing (and re-armed whenever the FIFO drains to empty mid-stream).
const PREBUFFER_SAMPLES: usize = RENDER_RATE * 150 / 1000;

/// Cap on the mix-bed (original-voice) ring buffer: ~500 ms of 48 kHz mono
/// audio. The bed is fed by `try_recv` and pulled one sample per output frame;
/// if the producer outruns the render clock we drop the oldest samples to bound
/// latency rather than let the buffer grow unboundedly.
const MIX_BED_CAP_SAMPLES: usize = RENDER_RATE * 500 / 1000;

/// Configuration for mixing the original voice (the "bed") under the translated
/// reply during playback.
///
/// The bed is **mono 48 kHz f32** — already at [`RENDER_RATE`], so no resampling
/// happens in the render loop. `gain` is a linear multiplier (e.g. `10^(dB/20)`)
/// applied per sample before summing with the translation and clamping to ±1.0.
pub struct MixConfig {
    /// Source of the bed: bursts of mono 48 kHz f32 samples. Drained via
    /// `try_recv` each tick; backpressure on the producer side is the caller's
    /// concern (it should drop, not block).
    pub rx: Receiver<Vec<f32>>,
    /// Linear gain applied to each bed sample before summing.
    pub gain: f32,
}

/// Handle to a running playback stream.
///
/// Dropping the handle signals the render thread to stop (without joining);
/// [`stop`](PlaybackHandle::stop) signals and then joins.
pub struct PlaybackHandle {
    /// Push mono PCM16 at `src_rate` here. Bursty; the channel disconnecting is
    /// the upstream's signal that playback died.
    pub tx: Sender<Vec<i16>>,
    /// Real queued audio awaiting render, in 48 kHz mono samples (the FIFO
    /// length). Drives ducking — reflects buffered translation only, never the
    /// silence we write to keep the engine primed. Known bias: samples still
    /// inside the resampler (sub-block residual + filter delay, a few ms) are
    /// not counted, so this can read 0 slightly before audio truly finishes —
    /// negligible next to the ducking release delay (~400 ms).
    pub queued_samples: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl PlaybackHandle {
    /// Signal the render thread to stop and wait for it to exit.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for PlaybackHandle {
    fn drop(&mut self) {
        // Signal stop on drop too, but never block joining here — `stop()` is
        // the explicit path for that.
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Start playback to `device_id` (or the default render device when `None`).
///
/// `src_rate` is the rate of the PCM pushed over [`PlaybackHandle::tx`]
/// (24000 from Gemini); it is resampled to [`RENDER_RATE`] internally.
///
/// Spawns the `audio-render` thread and blocks until the thread reports that
/// the stream started (returning the [`PlaybackHandle`]) or that
/// initialization failed (returning the error). The thread is never left
/// running silently on failure.
pub fn start_playback(device_id: Option<String>, src_rate: usize) -> anyhow::Result<PlaybackHandle> {
    start_playback_with_mix(device_id, src_rate, None)
}

/// Start playback to `device_id`, optionally mixing an original-voice bed under
/// the translated reply.
///
/// Identical to [`start_playback`] but, when `mix` is `Some`, the render loop
/// pulls mono 48 kHz f32 samples from [`MixConfig::rx`] and sums them (scaled by
/// [`MixConfig::gain`]) under every output frame — including the silence /
/// prebuffer frames, so the original voice keeps flowing even when no
/// translation is playing. See [`render_loop`] for the buffering details.
pub fn start_playback_with_mix(
    device_id: Option<String>,
    src_rate: usize,
    mix: Option<MixConfig>,
) -> anyhow::Result<PlaybackHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let queued_samples = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = bounded::<Vec<i16>>(CHANNEL_CAPACITY);
    // Synchronous init handshake: the thread sends exactly one message once it
    // either started the stream (Ok) or failed to initialize (Err).
    let (ready_tx, ready_rx) = bounded::<anyhow::Result<()>>(1);

    let thread_stop = Arc::clone(&stop);
    let thread_queued = Arc::clone(&queued_samples);

    let join = std::thread::Builder::new()
        .name("audio-render".to_string())
        .spawn(move || {
            render_thread(device_id, src_rate, thread_stop, thread_queued, rx, ready_tx, mix);
        })?;

    // Block until the thread reports readiness. A disconnect (thread panicked
    // before sending) is itself an error rather than a silent hang.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(PlaybackHandle {
            tx,
            queued_samples,
            stop,
            join: Some(join),
        }),
        Ok(Err(e)) => {
            let _ = join.join();
            Err(e)
        }
        Err(_) => {
            let _ = join.join();
            Err(anyhow::anyhow!(
                "render thread exited before reporting readiness"
            ))
        }
    }
}

/// Body of the `audio-render` thread. Sends its init result over `ready_tx`
/// exactly once, then (on success) runs the render loop until `stop` is set or
/// the device errors out.
#[allow(clippy::too_many_arguments)]
fn render_thread(
    device_id: Option<String>,
    src_rate: usize,
    stop: Arc<AtomicBool>,
    queued_samples: Arc<AtomicUsize>,
    rx: Receiver<Vec<i16>>,
    ready_tx: Sender<anyhow::Result<()>>,
    mix: Option<MixConfig>,
) {
    match setup_stream(device_id) {
        Ok(stream) => {
            let _ = ready_tx.send(Ok(()));
            render_loop(stream, src_rate, stop, &queued_samples, &rx, mix);
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    }
}

/// A started render stream plus the bits the loop needs each iteration.
struct Stream {
    audio_client: wasapi::AudioClient,
    render_client: wasapi::AudioRenderClient,
    event: wasapi::Handle,
}

/// Open the device, initialize the audio client, and start the stream.
fn setup_stream(device_id: Option<String>) -> anyhow::Result<Stream> {
    // COM (MTA) for this thread. Tolerate "already initialized" like the rest
    // of the codebase does; we never uninitialize.
    let _ = wasapi::initialize_mta().ok();

    let enumerator = wasapi::DeviceEnumerator::new()
        .map_err(|e| anyhow::anyhow!("failed to create device enumerator: {e}"))?;

    let device = match device_id {
        Some(ref id) => enumerator
            .get_device(id)
            .map_err(|e| anyhow::anyhow!("failed to open render device {id}: {e}"))?,
        None => enumerator
            .get_default_device(&wasapi::Direction::Render)
            .map_err(|e| anyhow::anyhow!("failed to open default render device: {e}"))?,
    };

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow::anyhow!("failed to get IAudioClient: {e}"))?;

    // Request 48 kHz, 32-bit float, stereo. AUTOCONVERTPCM lets the audio
    // engine reformat this into whatever the device's native mix format is.
    let desired_format = wasapi::WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        RENDER_RATE,
        RENDER_CHANNELS,
        None,
    );

    let (default_period, _min_period) = audio_client
        .get_device_period()
        .map_err(|e| anyhow::anyhow!("failed to get device period: {e}"))?;

    // Use the default period for render: a slightly larger buffer than the
    // engine minimum trades a little latency for underrun resilience, which is
    // what we want for bursty translated speech.
    let mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: default_period,
    };
    audio_client
        .initialize_client(&desired_format, &wasapi::Direction::Render, &mode)
        .map_err(|e| anyhow::anyhow!("failed to initialize render client: {e}"))?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow::anyhow!("failed to create render event handle: {e}"))?;

    let render_client = audio_client
        .get_audiorenderclient()
        .map_err(|e| anyhow::anyhow!("failed to get render client: {e}"))?;

    audio_client
        .start_stream()
        .map_err(|e| anyhow::anyhow!("failed to start render stream: {e}"))?;

    Ok(Stream {
        audio_client,
        render_client,
        event,
    })
}

/// Realtime render loop. Runs until `stop` is set or the device errors.
///
/// On a device error this logs a warning and returns; returning drops `rx`,
/// which disconnects the channel — the upstream's signal that playback died.
fn render_loop(
    stream: Stream,
    src_rate: usize,
    stop: Arc<AtomicBool>,
    queued_samples: &AtomicUsize,
    rx: &Receiver<Vec<i16>>,
    mix: Option<MixConfig>,
) {
    // One resampler instance for the life of the thread keeps its streaming
    // state continuous across bursts (no clicks at burst boundaries).
    let mut resampler = StreamResampler::new(src_rate, RENDER_RATE);
    // Mono 48 kHz FIFO of real audio awaiting render.
    let mut fifo: VecDeque<f32> = VecDeque::new();
    // Reused scratch for the interleaved stereo byte buffer handed to WASAPI.
    let mut byte_buf: Vec<u8> = Vec::new();

    // Mix bed (original voice): a local ring fed by `mix.rx`. Already mono
    // 48 kHz, so it needs no resampling — we pop one sample per output frame.
    // Capped at MIX_BED_CAP_SAMPLES (~500 ms); when the producer outruns the
    // render clock we drop the oldest samples to bound added latency.
    let mut bed: VecDeque<f32> = VecDeque::new();
    let bed_gain = mix.as_ref().map(|m| m.gain).unwrap_or(0.0);

    // `started` gates the prebuffer: false means we're filling the jitter
    // buffer (writing silence to the device) until the FIFO reaches
    // PREBUFFER_SAMPLES. It re-arms whenever the FIFO drains to empty.
    let mut started = false;

    let buffer_frames = match stream.audio_client.get_buffer_size() {
        Ok(f) => f as usize,
        Err(e) => {
            tracing::warn!("playback: failed to read buffer size, stopping: {e}");
            let _ = stream.audio_client.stop_stream();
            return;
        }
    };

    while !stop.load(Ordering::Relaxed) {
        // --- ingest: drain all pending bursts, resample into the FIFO ---
        while let Ok(chunk) = rx.try_recv() {
            let mono = i16_to_f32(&chunk);
            let resampled = resampler.push(&mono);
            fifo.extend(resampled);
        }
        queued_samples.store(fifo.len(), Ordering::Relaxed);

        // --- ingest the mix bed (original voice), if mixing is enabled ---
        // Already mono 48 kHz f32, so it goes straight into the ring. Keep only
        // the most recent ~500 ms (drop-oldest) to bound the added latency.
        if let Some(ref m) = mix {
            while let Ok(block) = m.rx.try_recv() {
                bed.extend(block);
            }
            while bed.len() > MIX_BED_CAP_SAMPLES {
                bed.pop_front();
            }
        }

        // (Re-)arm the prebuffer once enough audio has accumulated. While not
        // started we keep feeding silence below so the engine never underruns.
        if !started && fifo.len() >= PREBUFFER_SAMPLES {
            started = true;
        }

        // --- wait for the engine to free a slot in the buffer ---
        match stream.event.wait_for_event(EVENT_TIMEOUT_MS) {
            Ok(()) => {}
            Err(wasapi::WasapiError::EventTimeout) => continue,
            Err(e) => {
                tracing::warn!("playback: event wait failed, stopping: {e}");
                break;
            }
        }

        // How many frames the device can accept right now (buffer_frames minus
        // current padding). Equivalent to the task's `buffer_frames - padding`.
        let writable = match stream.audio_client.get_available_space_in_frames() {
            Ok(f) => f as usize,
            Err(e) => {
                tracing::warn!("playback: get available space failed, stopping: {e}");
                break;
            }
        }
        // Never ask for more than the buffer can hold.
        .min(buffer_frames);

        if writable == 0 {
            continue;
        }

        // Pop real audio only when started; otherwise emit silence to keep the
        // engine fed without consuming the (still-filling) jitter buffer.
        byte_buf.clear();
        byte_buf.reserve(writable * BYTES_PER_FRAME);
        for _ in 0..writable {
            // Underrun (or pre-start) → 0.0 silence for the translation.
            let base = if started {
                fifo.pop_front().unwrap_or(0.0)
            } else {
                0.0
            };
            // Mix the original voice under EVERY frame, including silence /
            // prebuffer frames, so the original keeps flowing even when no
            // translation is playing. When mixing is disabled the bed is always
            // empty, so this returns `base` unchanged.
            let sample = mix_sample(base, &mut bed, bed_gain);
            let bytes = sample.to_le_bytes();
            // Duplicate the mono sample to both stereo channels.
            byte_buf.extend_from_slice(&bytes);
            byte_buf.extend_from_slice(&bytes);
        }

        if let Err(e) = stream
            .render_client
            .write_to_device(writable, &byte_buf, None)
        {
            tracing::warn!("playback: write failed (device gone?), stopping: {e}");
            break;
        }

        // Publish the post-write FIFO length, and re-arm the prebuffer if we
        // just drained to empty (turn boundary between utterances).
        queued_samples.store(fifo.len(), Ordering::Relaxed);
        if started && fifo.is_empty() {
            started = false;
        }
    }

    let _ = stream.audio_client.stop_stream();
}

/// Mix one bed sample (original voice) under one base sample (translation).
///
/// Pops the next bed sample from `bed` (0.0 when the bed is empty — silence so
/// the base flows through untouched), scales it by `gain`, sums it with `base`,
/// and clamps the result to the valid f32 PCM range `[-1.0, 1.0]` to avoid
/// wrap-around / hard clipping artifacts on overflow.
///
/// Pure so the mixing math is unit-testable without audio hardware.
fn mix_sample(base: f32, bed: &mut VecDeque<f32>, gain: f32) -> f32 {
    let bed_sample = bed.pop_front().unwrap_or(0.0);
    (base + gain * bed_sample).clamp(-1.0, 1.0)
}

/// Interleave a mono f32 slice into stereo little-endian bytes by duplicating
/// each sample to both channels. Output is `mono.len() * BYTES_PER_FRAME` bytes.
///
/// Extracted as a pure helper so the byte layout is unit-testable without
/// audio hardware. The render loop inlines an equivalent loop to also handle
/// silence/underrun frames, but the LE layout is identical.
#[cfg(test)]
fn mono_to_stereo_le_bytes(mono: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(mono.len() * BYTES_PER_FRAME);
    for &s in mono {
        let bytes = s.to_le_bytes();
        out.extend_from_slice(&bytes); // left
        out.extend_from_slice(&bytes); // right
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_to_stereo_byte_layout() {
        let mono = [0.0f32, 1.0, -0.5];
        let out = mono_to_stereo_le_bytes(&mono);

        // 3 mono samples → 3 stereo frames → 3 * 8 bytes.
        assert_eq!(out.len(), mono.len() * BYTES_PER_FRAME);
        assert_eq!(out.len(), 24);

        // Each frame is [sample_le; sample_le]: left == right, both LE f32.
        for (i, &s) in mono.iter().enumerate() {
            let frame = &out[i * BYTES_PER_FRAME..(i + 1) * BYTES_PER_FRAME];
            let left = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
            let right = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
            assert_eq!(left.to_bits(), s.to_bits(), "left channel mismatch");
            assert_eq!(right.to_bits(), s.to_bits(), "right channel mismatch");
            // Explicit LE-order check on the raw bytes.
            assert_eq!(&frame[0..4], &s.to_le_bytes());
            assert_eq!(&frame[4..8], &s.to_le_bytes());
        }
    }

    #[test]
    fn empty_mono_yields_no_bytes() {
        assert!(mono_to_stereo_le_bytes(&[]).is_empty());
    }

    #[test]
    fn prebuffer_is_150ms_at_render_rate() {
        // 150 ms of 48 kHz == 7200 samples. Guards the constant against
        // accidental edits.
        assert_eq!(PREBUFFER_SAMPLES, 7200);
    }

    #[test]
    fn mix_bed_cap_is_500ms_at_render_rate() {
        // 500 ms of 48 kHz == 24000 samples. Guards the constant.
        assert_eq!(MIX_BED_CAP_SAMPLES, 24000);
    }

    #[test]
    fn mix_sample_empty_bed_returns_base() {
        // An empty bed contributes silence: the base passes through untouched,
        // even at unity gain.
        let mut bed: VecDeque<f32> = VecDeque::new();
        assert_eq!(mix_sample(0.5, &mut bed, 1.0), 0.5);
        assert_eq!(mix_sample(-0.25, &mut bed, 0.5), -0.25);
        assert_eq!(mix_sample(0.0, &mut bed, 1.0), 0.0);
    }

    #[test]
    fn mix_sample_applies_gain() {
        // bed sample is scaled by gain before summing, and consumed (popped).
        let mut bed: VecDeque<f32> = VecDeque::from(vec![0.4, 0.2]);
        // 0.1 + 0.5 * 0.4 = 0.3
        assert!((mix_sample(0.1, &mut bed, 0.5) - 0.3).abs() < 1e-6);
        // next call pops the second sample: 0.0 + 0.5 * 0.2 = 0.1
        assert!((mix_sample(0.0, &mut bed, 0.5) - 0.1).abs() < 1e-6);
        // bed now empty → base passes through.
        assert_eq!(mix_sample(0.7, &mut bed, 0.5), 0.7);
    }

    #[test]
    fn mix_sample_zero_gain_is_base() {
        // Zero gain mutes the bed entirely (but still consumes the sample).
        let mut bed: VecDeque<f32> = VecDeque::from(vec![1.0]);
        assert_eq!(mix_sample(0.3, &mut bed, 0.0), 0.3);
        assert!(bed.is_empty(), "bed sample should still be consumed");
    }

    #[test]
    fn mix_sample_clamps_to_unit_range() {
        // Positive overflow clamps to +1.0.
        let mut bed: VecDeque<f32> = VecDeque::from(vec![1.0]);
        assert_eq!(mix_sample(0.8, &mut bed, 1.0), 1.0);
        // Negative overflow clamps to -1.0.
        let mut bed: VecDeque<f32> = VecDeque::from(vec![-1.0]);
        assert_eq!(mix_sample(-0.8, &mut bed, 1.0), -1.0);
        // Exactly at the boundary is preserved.
        let mut bed: VecDeque<f32> = VecDeque::from(vec![0.5]);
        assert_eq!(mix_sample(0.5, &mut bed, 1.0), 1.0);
    }

    #[test]
    #[ignore = "plays audible tone"]
    fn tone_2s() {
        let h = start_playback(None, 24000).unwrap();
        for i in 0..20 {
            let chunk: Vec<i16> = (0..2400)
                .map(|n| {
                    let t = (i * 2400 + n) as f32 / 24000.0;
                    ((t * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16
                })
                .collect();
            h.tx.send(chunk).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        h.stop();
    }
}
