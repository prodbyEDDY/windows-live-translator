//! WASAPI microphone capture engine.
//!
//! [`start_capture`] spawns a dedicated realtime thread (`audio-capture`) that
//! opens a WASAPI capture endpoint in shared, event-driven mode, requesting a
//! 48 kHz / f32 / stereo stream with automatic format conversion. The thread
//! downmixes each captured packet to mono and pushes `Vec<f32>` blocks over a
//! crossbeam channel; per-block RMS level (dB × 100) is published via an atomic.
//!
//! ## wasapi 0.23 adaptation notes
//! * `StreamMode::EventsShared { autoconvert: true, .. }` is what enables the
//!   `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`
//!   pair internally (see `initialize_client` in the crate). There is no
//!   separate flag argument to pass.
//! * Captured audio is drained with `AudioCaptureClient::read_from_device_to_deque`,
//!   which appends raw interleaved bytes to a `VecDeque<u8>`. We reinterpret
//!   those bytes as f32 (our requested format) before downmixing.
//! * `Handle::wait_for_event` returns `Err(WasapiError::EventTimeout)` on
//!   timeout; we treat that as "no data yet" and loop again so the stop flag is
//!   polled at least every 200 ms.

use crossbeam_channel::{bounded, Receiver, Sender};
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Arc,
};

use super::dsp::{downmix_mono, rms_db};

/// Output sample rate of the capture engine (mono, f32).
pub const CAPTURE_RATE: usize = 48000;

/// Channels we request from WASAPI (downmixed to mono before emitting).
const CAPTURE_CHANNELS: usize = 2;

/// Bounded capacity of the audio block channel. Each block is ~10 ms, so this is
/// a few hundred ms of slack before the realtime thread starts dropping blocks.
const CHANNEL_CAPACITY: usize = 32;

/// Event-wait timeout. Bounds how long the loop can block before it re-checks
/// the stop flag, so [`CaptureHandle::stop`] joins promptly.
const EVENT_TIMEOUT_MS: u32 = 200;

/// What to capture.
#[derive(Debug, Clone)]
pub enum CaptureSource {
    /// A capture (input) device. `None` selects the default capture device.
    Mic { device_id: Option<String> },
    /// A single process's render audio (process loopback). Task 10.
    App { pid: u32 },
    /// System render audio excluding our own process. Task 10.
    SystemExcludeSelf,
}

/// Handle to a running capture stream.
///
/// Dropping the handle signals the capture thread to stop (without joining);
/// [`stop`](CaptureHandle::stop) signals and then joins.
pub struct CaptureHandle {
    /// Mono 48 kHz f32 blocks (~10 ms each; exact size is not guaranteed). The
    /// channel disconnecting is the upstream's signal that the source died.
    pub rx: Receiver<Vec<f32>>,
    /// RMS level of the most recent block, as dB × 100 (e.g. -2350 == -23.5 dB).
    pub level_db_x100: Arc<AtomicI32>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl CaptureHandle {
    /// Signal the capture thread to stop and wait for it to exit.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        // Signal stop on drop too, but never block joining here — `stop()` is the
        // explicit path for that.
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Start capturing from `source`.
///
/// Spawns the `audio-capture` thread and blocks until the thread reports that
/// the stream started (returning the [`CaptureHandle`]) or that initialization
/// failed (returning the error). The thread is never left running silently on
/// failure.
pub fn start_capture(source: CaptureSource) -> anyhow::Result<CaptureHandle> {
    let stop = Arc::new(AtomicBool::new(false));
    let level_db_x100 = Arc::new(AtomicI32::new((rms_db(&[]) * 100.0) as i32));
    let (tx, rx) = bounded::<Vec<f32>>(CHANNEL_CAPACITY);
    // Synchronous init handshake: the thread sends exactly one message once it
    // either started the stream (Ok) or failed to initialize (Err).
    let (ready_tx, ready_rx) = bounded::<anyhow::Result<()>>(1);

    let thread_stop = Arc::clone(&stop);
    let thread_level = Arc::clone(&level_db_x100);

    let join = std::thread::Builder::new()
        .name("audio-capture".to_string())
        .spawn(move || {
            capture_thread(source, thread_stop, thread_level, tx, ready_tx);
        })?;

    // Block until the thread reports readiness. A disconnect (thread panicked
    // before sending) is itself an error rather than a silent hang.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(CaptureHandle {
            rx,
            level_db_x100,
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
                "capture thread exited before reporting readiness"
            ))
        }
    }
}

/// Body of the `audio-capture` thread. Sends its init result over `ready_tx`
/// exactly once, then (on success) runs the capture loop until `stop` is set or
/// the device errors out.
fn capture_thread(
    source: CaptureSource,
    stop: Arc<AtomicBool>,
    level_db_x100: Arc<AtomicI32>,
    tx: Sender<Vec<f32>>,
    ready_tx: Sender<anyhow::Result<()>>,
) {
    let setup = setup_stream(&source);
    match setup {
        Ok(stream) => {
            // Stream started — tell start_capture we're live, then run the loop.
            let _ = ready_tx.send(Ok(()));
            capture_loop(stream, stop, &level_db_x100, &tx);
        }
        Err(e) => {
            // Init failed — hand the error back; start_capture returns it.
            let _ = ready_tx.send(Err(e));
        }
    }
}

/// A started capture stream plus the bits the loop needs each iteration.
struct Stream {
    audio_client: wasapi::AudioClient,
    capture_client: wasapi::AudioCaptureClient,
    event: wasapi::Handle,
    bytes_per_frame: usize,
    channels: usize,
}

/// Open the device, initialize the audio client, and start the stream.
fn setup_stream(source: &CaptureSource) -> anyhow::Result<Stream> {
    // COM (MTA) for this thread. Tolerate "already initialized" like the rest of
    // the codebase does; we never uninitialize.
    let _ = wasapi::initialize_mta().ok();

    let device = match source {
        CaptureSource::Mic { device_id } => {
            let enumerator = wasapi::DeviceEnumerator::new()
                .map_err(|e| anyhow::anyhow!("failed to create device enumerator: {e}"))?;
            match device_id {
                Some(id) => enumerator
                    .get_device(id)
                    .map_err(|e| anyhow::anyhow!("failed to open capture device {id}: {e}"))?,
                None => enumerator
                    .get_default_device(&wasapi::Direction::Capture)
                    .map_err(|e| anyhow::anyhow!("failed to open default capture device: {e}"))?,
            }
        }
        CaptureSource::App { .. } | CaptureSource::SystemExcludeSelf => {
            anyhow::bail!("process loopback lands in Task 10");
        }
    };

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow::anyhow!("failed to get IAudioClient: {e}"))?;

    // Request 48 kHz, 32-bit float, stereo. AUTOCONVERTPCM lets the audio engine
    // resample/reformat whatever the device's native mix format is into this.
    let desired_format = wasapi::WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        CAPTURE_RATE,
        CAPTURE_CHANNELS,
        None,
    );

    // Use the engine's minimum period for the buffer duration — lowest latency
    // shared-mode buffer the engine will grant.
    let (_default_period, min_period) = audio_client
        .get_device_period()
        .map_err(|e| anyhow::anyhow!("failed to get device period: {e}"))?;

    let mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    audio_client
        .initialize_client(&desired_format, &wasapi::Direction::Capture, &mode)
        .map_err(|e| anyhow::anyhow!("failed to initialize capture client: {e}"))?;

    let event = audio_client
        .set_get_eventhandle()
        .map_err(|e| anyhow::anyhow!("failed to create capture event handle: {e}"))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| anyhow::anyhow!("failed to get capture client: {e}"))?;

    let bytes_per_frame = desired_format.get_blockalign() as usize;

    audio_client
        .start_stream()
        .map_err(|e| anyhow::anyhow!("failed to start capture stream: {e}"))?;

    Ok(Stream {
        audio_client,
        capture_client,
        event,
        bytes_per_frame,
        channels: CAPTURE_CHANNELS,
    })
}

/// Realtime capture loop. Runs until `stop` is set or the device errors.
///
/// On a device error (e.g. unplug) this logs a warning and returns; returning
/// drops `tx`, which disconnects the channel — the upstream's signal that the
/// source died.
fn capture_loop(
    stream: Stream,
    stop: Arc<AtomicBool>,
    level_db_x100: &AtomicI32,
    tx: &Sender<Vec<f32>>,
) {
    // Raw interleaved bytes accumulate here between reads.
    let mut byte_queue: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
    // Scratch buffer reused across iterations to keep f32 conversion allocation
    // off the hot path where possible.
    let mut frame_bytes: Vec<u8> = Vec::new();

    while !stop.load(Ordering::Relaxed) {
        // Wait for the engine to signal that a packet is ready. Timeout just
        // means "no data this interval" — loop so we re-check the stop flag.
        match stream.event.wait_for_event(EVENT_TIMEOUT_MS) {
            Ok(()) => {}
            Err(wasapi::WasapiError::EventTimeout) => continue,
            Err(e) => {
                tracing::warn!("capture: event wait failed, stopping: {e}");
                break;
            }
        }

        // Drain everything currently available into our byte queue.
        if let Err(e) = stream.capture_client.read_from_device_to_deque(&mut byte_queue) {
            tracing::warn!("capture: read failed (device gone?), stopping: {e}");
            break;
        }

        // Convert whole frames to mono f32 blocks and emit. We emit per drained
        // batch (one block) rather than per fixed size — block size is not
        // guaranteed by the contract.
        let bytes_per_frame = stream.bytes_per_frame;
        let whole = byte_queue.len() - (byte_queue.len() % bytes_per_frame);
        if whole == 0 {
            continue;
        }

        frame_bytes.clear();
        frame_bytes.extend(byte_queue.drain(..whole));

        let interleaved = bytes_to_f32(&frame_bytes);
        let mono = downmix_mono(&interleaved, stream.channels);

        // Publish level before the (possibly dropping) send so the meter stays
        // live even under backpressure.
        let db = rms_db(&mono);
        level_db_x100.store((db * 100.0) as i32, Ordering::Relaxed);

        // Drop on backpressure — the realtime thread must never block.
        let _ = tx.try_send(mono);
    }

    let _ = stream.audio_client.stop_stream();
}

/// Reinterpret a little-endian f32 byte buffer as `Vec<f32>`. `bytes.len()` is
/// assumed to be a multiple of 4 (whole frames of f32 samples).
fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_to_f32_roundtrips() {
        let vals = [0.0f32, 1.0, -1.0, 0.5];
        let mut bytes = Vec::new();
        for v in vals {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(bytes_to_f32(&bytes), vals.to_vec());
    }

    #[test]
    fn app_source_bails_until_task_10() {
        // CaptureHandle has no Debug impl, so match instead of unwrap_err().
        for src in [
            CaptureSource::App { pid: 1234 },
            CaptureSource::SystemExcludeSelf,
        ] {
            match start_capture(src) {
                Ok(_) => panic!("process loopback should bail until Task 10"),
                Err(e) => assert!(e.to_string().contains("Task 10")),
            }
        }
    }

    #[test]
    #[ignore = "requires mic hardware"]
    fn mic_capture_3s() {
        let h = start_capture(CaptureSource::Mic { device_id: None }).unwrap();
        let mut samples: Vec<f32> = Vec::new();
        let mut min_level = i32::MAX;
        let mut max_level = i32::MIN;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            if let Ok(block) = h.rx.recv_timeout(std::time::Duration::from_millis(300)) {
                let lvl = h.level_db_x100.load(Ordering::Relaxed);
                min_level = min_level.min(lvl);
                max_level = max_level.max(lvl);
                samples.extend(block);
            }
        }
        h.stop();
        // ~3s of mono 48k: allow generous slack for startup
        assert!(samples.len() > 100_000, "captured only {} samples", samples.len());
        // write wav for human listening check
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut w = hound::WavWriter::create(std::env::temp_dir().join("mic_test.wav"), spec).unwrap();
        for s in &samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
        println!("wrote {} samples to %TEMP%\\mic_test.wav", samples.len());
        println!(
            "level_db_x100 range: min={} max={} ({:.1} dB .. {:.1} dB)",
            min_level,
            max_level,
            min_level as f32 / 100.0,
            max_level as f32 / 100.0
        );
    }
}
