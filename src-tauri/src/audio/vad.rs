//! Energy-based voice-activity detection (VAD) for the "economy" mode.
//!
//! When economy mode is enabled, the OUT/IN bridges run each raw 48 kHz mono
//! block through an [`EnergyVad`] *before* resampling. Silent blocks are not
//! streamed to Gemini (saving session minutes), while a short pre-roll ring of
//! recent chunks is flushed on resume so the first word isn't clipped.
//!
//! This is a deliberately simple RMS-threshold state machine with hangover:
//! * A block whose `rms_db` exceeds the threshold is speech.
//! * Once speaking, we stay "speaking" for `hangover_ms` of continuous quiet
//!   before declaring silence — this rides over the natural gaps inside a
//!   sentence so we don't chop words mid-phrase.
//! * Any loud block resets the accumulated quiet time.

use crate::audio::dsp::rms_db;

/// Per-block decision emitted by [`EnergyVad::push`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadDecision {
    /// We were already speaking and this block is (or counts as) speech.
    Speech,
    /// This block re-opened speech after a silent stretch — flush the pre-roll.
    JustResumed,
    /// Below threshold while not speaking — drop this block.
    Silence,
}

/// RMS threshold (dBFS) at/above which a block counts as speech.
const DEFAULT_THRESHOLD_DB: f32 = -45.0;
/// Continuous quiet (ms) required, while speaking, before declaring silence.
const DEFAULT_HANGOVER_MS: u32 = 800;

/// Energy VAD state machine over mono 48 kHz f32 blocks.
pub struct EnergyVad {
    /// RMS threshold in dBFS; blocks above this are speech.
    threshold_db: f32,
    /// Continuous quiet (ms) required, while speaking, before silence.
    hangover_ms: u32,
    /// Accumulated continuous quiet (ms) since the last loud block.
    silent_ms: u32,
    /// Whether we currently consider the stream to be speech.
    speaking: bool,
}

impl Default for EnergyVad {
    fn default() -> Self {
        Self::new()
    }
}

impl EnergyVad {
    /// Construct a VAD with the default −45 dB threshold and 800 ms hangover,
    /// starting in the non-speaking (silent) state.
    pub fn new() -> Self {
        Self {
            threshold_db: DEFAULT_THRESHOLD_DB,
            hangover_ms: DEFAULT_HANGOVER_MS,
            silent_ms: 0,
            speaking: false,
        }
    }

    /// Feed one mono 48 kHz f32 block and get the decision for it.
    ///
    /// Block duration is derived from the length: at 48 kHz there are 48 samples
    /// per millisecond, so `block_ms = block.len() / 48`.
    ///
    /// * `rms_db(block) > threshold` → a loud block. The quiet accumulator
    ///   resets. If we weren't speaking we transition to speaking and return
    ///   [`VadDecision::JustResumed`]; otherwise [`VadDecision::Speech`].
    /// * below threshold while speaking → accumulate `silent_ms`; once it
    ///   reaches `hangover_ms` we stop speaking. Either way this block still
    ///   counts as [`VadDecision::Speech`] (the hangover tail is kept).
    /// * below threshold while not speaking → [`VadDecision::Silence`].
    pub fn push(&mut self, block: &[f32]) -> VadDecision {
        let block_ms = block.len() as f32 / 48.0;
        if rms_db(block) > self.threshold_db {
            // Loud block: reset the quiet accumulator.
            self.silent_ms = 0;
            if self.speaking {
                VadDecision::Speech
            } else {
                self.speaking = true;
                VadDecision::JustResumed
            }
        } else if self.speaking {
            // Quiet but within hangover — still treated as speech.
            self.silent_ms = self.silent_ms.saturating_add(block_ms as u32);
            if self.silent_ms >= self.hangover_ms {
                self.speaking = false;
            }
            VadDecision::Speech
        } else {
            VadDecision::Silence
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loud 48 kHz block (`block_ms` ms long) well above the −45 dB threshold.
    fn loud(block_ms: usize) -> Vec<f32> {
        vec![0.3f32; block_ms * 48]
    }

    /// A silent block of the given duration.
    fn quiet(block_ms: usize) -> Vec<f32> {
        vec![0.0f32; block_ms * 48]
    }

    #[test]
    fn starts_silent() {
        let mut vad = EnergyVad::new();
        // First quiet block while not speaking → Silence (dropped).
        assert_eq!(vad.push(&quiet(20)), VadDecision::Silence);
    }

    #[test]
    fn first_loud_block_just_resumed_then_speech() {
        let mut vad = EnergyVad::new();
        assert_eq!(vad.push(&loud(20)), VadDecision::JustResumed);
        assert_eq!(vad.push(&loud(20)), VadDecision::Speech);
    }

    #[test]
    fn quiet_within_hangover_stays_speech() {
        let mut vad = EnergyVad::new();
        assert_eq!(vad.push(&loud(20)), VadDecision::JustResumed);
        // 700 ms of quiet (< 800 ms hangover) → still Speech.
        for _ in 0..35 {
            assert_eq!(vad.push(&quiet(20)), VadDecision::Speech);
        }
    }

    #[test]
    fn silence_after_full_hangover() {
        let mut vad = EnergyVad::new();
        assert_eq!(vad.push(&loud(20)), VadDecision::JustResumed);
        // 800 ms of quiet = 40 × 20 ms blocks. The block that crosses the
        // threshold is still Speech (hangover tail), the next is Silence.
        for _ in 0..40 {
            assert_eq!(vad.push(&quiet(20)), VadDecision::Speech);
        }
        assert_eq!(vad.push(&quiet(20)), VadDecision::Silence);
    }

    #[test]
    fn loud_again_after_silence_just_resumed() {
        let mut vad = EnergyVad::new();
        // Speak, fall fully silent, then speak again.
        vad.push(&loud(20));
        for _ in 0..40 {
            vad.push(&quiet(20));
        }
        assert_eq!(vad.push(&quiet(20)), VadDecision::Silence);
        // New speech onset → JustResumed (flush the pre-roll).
        assert_eq!(vad.push(&loud(20)), VadDecision::JustResumed);
    }

    #[test]
    fn loud_block_resets_silent_accumulator() {
        let mut vad = EnergyVad::new();
        vad.push(&loud(20)); // JustResumed
                             // 600 ms quiet (under hangover)…
        for _ in 0..30 {
            assert_eq!(vad.push(&quiet(20)), VadDecision::Speech);
        }
        // …a loud blip resets the accumulator…
        assert_eq!(vad.push(&loud(20)), VadDecision::Speech);
        // …so another 700 ms of quiet still stays Speech (no premature silence).
        for _ in 0..35 {
            assert_eq!(vad.push(&quiet(20)), VadDecision::Speech);
        }
    }
}
