use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};
use rubato::audioadapter_buffers::direct::SequentialSlice;

/// Mix a multi-channel interleaved buffer down to mono by averaging channels.
///
/// # Panics (debug only)
/// Asserts that `interleaved.len()` is a multiple of `channels`.
pub fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    debug_assert!(
        interleaved.len().is_multiple_of(channels),
        "interleaved buffer length {} is not a multiple of channels {}",
        interleaved.len(),
        channels
    );
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Convert f32 PCM samples (−1.0 … +1.0) to i16.
///
/// Uses 32767 as the positive full-scale multiplier intentionally: this is a
/// one-way encoding pipeline (f32 → wire format), so asymmetry is acceptable
/// and avoids overflow on the positive side. Do not "fix" this to 32768.
pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect()
}

/// Convert i16 PCM samples to f32 (−1.0 … +1.0).
///
/// Uses 32768 as the divisor intentionally: the minimum i16 value (−32768)
/// maps exactly to −1.0, while the maximum (+32767) maps to ≈ +0.9999695.
/// This is a one-way decoding pipeline (wire format → f32), so the slight
/// asymmetry is expected and correct. Do not "fix" this to 32767.
pub fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|s| *s as f32 / 32768.0).collect()
}

pub fn rms_db(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let ms = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    10.0 * (ms.max(1e-12)).log10()
}

/// Streaming mono resampler accepting arbitrary input lengths.
///
/// Uses `process_into_buffer` with a pre-allocated output buffer (sized via
/// `output_frames_max()` at construction) to avoid per-block heap allocation
/// on the hot path. Input blocking uses `input_frames_next()` so the block
/// size stays accurate across any internal state changes.
pub struct StreamResampler {
    inner: Async<f32>,
    /// Pre-allocated output buffer (mono: 1 channel × output_frames_max frames).
    out_buf: Vec<f32>,
    /// Accumulated input samples not yet consumed.
    buf: Vec<f32>,
}

impl StreamResampler {
    pub fn new(from_hz: usize, to_hz: usize) -> Self {
        let block = from_hz / 100; // 10 ms input block
        let ratio = to_hz as f64 / from_hz as f64;
        // max_resample_ratio_relative=1.0 means ratio is fixed (no drift)
        let inner = Async::<f32>::new_poly(
            ratio,
            1.0,
            PolynomialDegree::Septic,
            block,
            1, // mono
            FixedAsync::Input,
        )
        .expect("StreamResampler construction failed");
        // Pre-allocate output buffer: rubato recommends this for realtime use.
        // output_frames_max() gives the upper bound of frames per process call.
        let out_frames = inner.output_frames_max();
        let out_buf = vec![0.0f32; out_frames]; // 1 channel × out_frames
        Self {
            inner,
            out_buf,
            buf: Vec::new(),
        }
    }

    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        // Use input_frames_next() instead of a stored block field so the
        // required input size is always accurate.
        while self.buf.len() >= self.inner.input_frames_next() {
            let block = self.inner.input_frames_next();
            // Build adapters directly from slices — no drain/collect allocation.
            // For mono, sequential layout is identical to a plain flat slice.
            let in_adapter = SequentialSlice::new(&self.buf[..block], 1, block)
                .expect("input adapter");
            let out_capacity = self.out_buf.len();
            let mut out_adapter =
                SequentialSlice::new_mut(&mut self.out_buf[..], 1, out_capacity)
                    .expect("output adapter");
            if let Ok((_in_frames, frames)) =
                self.inner.process_into_buffer(&in_adapter, &mut out_adapter, None)
            {
                // Copy only the produced frames; no per-sample read_sample call.
                out.extend_from_slice(&self.out_buf[..frames]);
            }
            // Drain the consumed input only after the borrow on self.buf ends.
            self.buf.drain(..block);
        }
        out
    }
}

pub struct Chunker {
    buf: Vec<i16>,
    size: usize,
}

impl Chunker {
    pub fn new(size: usize) -> Self {
        Self {
            buf: Vec::new(),
            size,
        }
    }

    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        self.buf.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.buf.len() >= self.size {
            out.push(self.buf.drain(..self.size).collect());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(downmix_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(downmix_mono(&[0.3, 0.3], 1), vec![0.3, 0.3]);
    }

    #[test]
    fn f32_to_i16_clamps() {
        assert_eq!(
            f32_to_i16(&[0.0, 1.0, -1.0, 2.0]),
            vec![0, 32767, -32767, 32767]
        );
    }

    #[test]
    fn chunker_emits_fixed_chunks() {
        let mut c = Chunker::new(1600);
        assert!(c.push(&vec![0i16; 1000]).is_empty());
        let out = c.push(&vec![0i16; 2400]);
        assert_eq!(out.len(), 2); // 3400 total -> 2 chunks, 200 remain
        assert!(out.iter().all(|ch| ch.len() == 1600));
    }

    #[test]
    fn resampler_48k_to_16k_ratio() {
        let mut r = StreamResampler::new(48000, 16000);
        let mut total_out = 0usize;
        for _ in 0..100 {
            total_out += r.push(&vec![0.0f32; 480]).len();
        } // 1s of 48k in 10ms blocks
        let expected = 16000;
        assert!(
            (total_out as i64 - expected as i64).abs() < 800,
            "got {total_out}"
        );
    }

    #[test]
    fn resampler_24k_to_48k_ratio() {
        let mut r = StreamResampler::new(24000, 48000);
        let mut total_out = 0usize;
        for _ in 0..100 {
            total_out += r.push(&vec![0.0f32; 240]).len();
        }
        assert!(
            (total_out as i64 - 48000i64).abs() < 2400,
            "got {total_out}"
        );
    }

    #[test]
    fn rms_db_silence_is_low() {
        assert!(rms_db(&vec![0.0; 480]) < -80.0);
        assert!(rms_db(&vec![0.5; 480]) > -10.0);
    }
}
