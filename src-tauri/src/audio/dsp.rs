use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};
use rubato::audioadapter::Adapter;
use rubato::audioadapter_buffers::direct::InterleavedSlice;

pub fn downmix_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

pub fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .collect()
}

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
/// Rubato 3.0 adaptation: replaces `FastFixedIn` / `PolynomialDegree` (0.16 API)
/// with `Async::new_poly` + `FixedAsync::Input` (3.0 API). The `process()` method
/// now takes an `Adapter` trait object; we wrap slices via
/// `rubato::audioadapter_buffers::direct::InterleavedSlice`.
pub struct StreamResampler {
    inner: Async<f32>,
    block: usize,
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
        Self {
            inner,
            block,
            buf: Vec::new(),
        }
    }

    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        self.buf.extend_from_slice(input);
        let mut out = Vec::new();
        while self.buf.len() >= self.block {
            let chunk: Vec<f32> = self.buf.drain(..self.block).collect();
            let adapter = InterleavedSlice::new(&chunk[..], 1, chunk.len())
                .expect("input adapter");
            if let Ok(owned) = self.inner.process(&adapter, 0, None) {
                // For mono (1 channel), interleaved layout == plain samples.
                // output_frames_next() tells us how many frames were actually produced.
                let frames = owned.frames();
                for f in 0..frames {
                    // SAFETY: channel 0, frame f are always in-bounds for a 1-ch buffer.
                    out.push(owned.read_sample(0, f).unwrap_or(0.0));
                }
            }
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
