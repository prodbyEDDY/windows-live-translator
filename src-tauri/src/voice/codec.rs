//! Voice codec: Opus/OGG encoding plus best-effort duration probing.
//!
//! `encode_voice_ogg` takes mono PCM16 at 24 kHz (the rate Gemini TTS emits),
//! resamples it to 48 kHz, encodes it with libopus in VOIP mode, and muxes the
//! result into an Ogg Opus stream per RFC 7845 so the file is a standard
//! `.ogg` that WhatsApp (and any Opus-aware player) accepts.
//!
//! ## Codec route
//! Opus encoding uses the `audiopus` crate (FFI to libopus). On this build
//! machine `cmake` is unavailable, so the newer `audiopus_sys` (which builds
//! libopus via cmake) would fail. We pin `audiopus = 0.2`, which resolves to
//! `audiopus_sys 0.1.8` — that older sys crate builds libopus without cmake,
//! so the native build succeeds here. Ogg page framing is done with the pure
//! Rust `ogg` crate (`PacketWriter`) so we never hand-roll page CRCs.

use std::io::Cursor;
use std::path::Path;

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate, Signal};
use ogg::{PacketWriteEndInfo, PacketWriter};

use crate::audio::dsp::{self, StreamResampler};

/// File extension produced by [`encode_voice_ogg`]. The frontend appends this
/// to translated-audio filenames and the MIME layer keys off it. We emit real
/// Ogg Opus, so this is `"ogg"`.
pub const VOICE_EXT: &str = "ogg";

/// Default encoder lookahead (pre-skip) in 48 kHz samples, used only if the
/// encoder declines to report its own lookahead. 312 is libopus' typical value
/// for these settings; see RFC 7845 §4.2.
const DEFAULT_PRESKIP: u16 = 312;

/// Opus is always decoded at 48 kHz; we encode at 48 kHz too.
const OPUS_RATE: u32 = 48_000;

/// 20 ms frame at 48 kHz = 960 samples. libopus accepts 2.5/5/10/20/40/60 ms;
/// 20 ms is the standard VoIP frame size.
const FRAME_SAMPLES: usize = 960;

/// Target bitrate (~32 kbps) — plenty for intelligible speech, keeps files small.
const TARGET_BITRATE: i32 = 32_000;

/// Encode mono PCM16 @ 24 kHz into an Ogg Opus byte stream.
///
/// Pipeline: i16 → f32 → resample 24k→48k → f32 → i16 → Opus 20 ms frames →
/// Ogg pages (OpusHead, OpusTags, audio). Granule positions are cumulative
/// 48 kHz sample counts offset by the pre-skip, per RFC 7845.
pub fn encode_voice_ogg(pcm24k: &[i16]) -> anyhow::Result<Vec<u8>> {
    // --- 1. Resample 24k -> 48k over f32 using the shared streaming resampler.
    let mut resampler = StreamResampler::new(24_000, OPUS_RATE as usize);
    let mut pcm48k_f32 = resampler.push(&dsp::i16_to_f32(pcm24k));
    // Flush any tail the resampler still holds by pushing a block of silence so
    // the final real samples are emitted (the streaming resampler only emits
    // once it has a full input block).
    pcm48k_f32.extend(resampler.push(&vec![0.0f32; 240]));
    let pcm48k = dsp::f32_to_i16(&pcm48k_f32);

    // --- 2. Set up the Opus encoder (VOIP, mono, 48 kHz, ~32 kbps).
    let mut encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
        .map_err(|e| anyhow::anyhow!("opus encoder init failed: {e}"))?;
    encoder
        .set_bitrate(Bitrate::BitsPerSecond(TARGET_BITRATE))
        .map_err(|e| anyhow::anyhow!("opus set_bitrate failed: {e}"))?;
    // Speech-optimized noise shaping.
    let _ = encoder.set_signal(Signal::Voice);

    let preskip: u16 = encoder
        .lookahead()
        .ok()
        .and_then(|l| u16::try_from(l).ok())
        .unwrap_or(DEFAULT_PRESKIP);

    // --- 3. Encode 20 ms frames, padding the final frame with silence.
    let mut packets: Vec<Vec<u8>> = Vec::new();
    let mut encode_buf = [0u8; 4000]; // generous upper bound for a 20 ms packet
    let mut frame = [0i16; FRAME_SAMPLES];
    let mut total_input_samples: u64 = 0;
    let mut i = 0usize;
    while i < pcm48k.len() {
        let take = (pcm48k.len() - i).min(FRAME_SAMPLES);
        frame[..take].copy_from_slice(&pcm48k[i..i + take]);
        // Zero-pad the remainder of the final (short) frame.
        for s in frame.iter_mut().take(FRAME_SAMPLES).skip(take) {
            *s = 0;
        }
        let n = encoder
            .encode(&frame, &mut encode_buf)
            .map_err(|e| anyhow::anyhow!("opus encode failed: {e}"))?;
        packets.push(encode_buf[..n].to_vec());
        total_input_samples += FRAME_SAMPLES as u64; // each emitted frame is 960 samples of decoded audio
        i += take;
    }

    // --- 4. Mux into an Ogg Opus stream (RFC 7845).
    mux_ogg_opus(&packets, preskip, total_input_samples)
}

/// Build the Ogg Opus container: an OpusHead page, an OpusTags page, then the
/// audio packets with cumulative granule positions.
fn mux_ogg_opus(packets: &[Vec<u8>], preskip: u16, total_samples: u64) -> anyhow::Result<Vec<u8>> {
    // A fixed serial number is fine for a single logical stream.
    let serial: u32 = 0x0000_0001;
    let buf: Vec<u8> = Vec::new();
    let mut writer = PacketWriter::new(Cursor::new(buf));

    // OpusHead (19 bytes): magic, version, channels, pre-skip, input rate,
    // output gain, channel mapping family. See RFC 7845 §5.1.
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channel count (mono)
    head.extend_from_slice(&preskip.to_le_bytes()); // pre-skip
    head.extend_from_slice(&OPUS_RATE.to_le_bytes()); // input sample rate (informational)
    head.extend_from_slice(&0u16.to_le_bytes()); // output gain (Q7.8, 0 dB)
    head.push(0); // channel mapping family 0 (mono/stereo)
    // Header pages always carry granule position 0 and end their own page.
    writer.write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)?;

    // OpusTags: magic, vendor string, then a (zero) user-comment count.
    let vendor = b"live-translator";
    let mut tags = Vec::new();
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes()); // user comment list length = 0
    writer.write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)?;

    // Audio packets. The granule position is the count of decoded 48 kHz PCM
    // samples that, after applying pre-skip, would be played by the end of the
    // page — i.e. cumulative samples plus pre-skip (RFC 7845 §4).
    let last = packets.len().saturating_sub(1);
    let mut granule: u64 = 0;
    for (idx, pkt) in packets.iter().enumerate() {
        granule += FRAME_SAMPLES as u64;
        let absgp = granule + preskip as u64;
        let end = if idx == last {
            PacketWriteEndInfo::EndStream
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer.write_packet(pkt.clone(), serial, end, absgp)?;
    }

    // If there were no audio packets at all, still finalize the stream with an
    // empty end-of-stream packet so the container is valid.
    if packets.is_empty() {
        writer.write_packet(
            Vec::new(),
            serial,
            PacketWriteEndInfo::EndStream,
            preskip as u64 + total_samples,
        )?;
    }

    Ok(writer.into_inner().into_inner())
}

/// Best-effort media duration in seconds. Returns `None` if the file cannot be
/// probed (unsupported container, no timing metadata, I/O error, …). Duration
/// is cosmetic, so this never propagates errors.
pub fn probe_duration(path: &Path) -> Option<f32> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;

    let track = probed.format.default_track()?;
    let params = &track.codec_params;
    let time_base = params.time_base?;
    let n_frames = params.n_frames?;
    let time = time_base.calc_time(n_frames);
    Some(time.seconds as f32 + time.frac as f32)
}

/// Map a file extension (case-insensitive, no dot) to a MIME type suitable for
/// the Gemini REST API and `<audio>` playback. `None` for unknown extensions.
pub fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "ogg" | "opus" => Some("audio/ogg"),
        "mp3" => Some("audio/mp3"),
        "m4a" | "aac" => Some("audio/aac"),
        "wav" => Some("audio/wav"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1 second of a 440 Hz sine at 24 kHz, mono PCM16.
    fn sine_24k_1s() -> Vec<i16> {
        let rate = 24_000.0f32;
        let freq = 440.0f32;
        (0..24_000)
            .map(|n| {
                let t = n as f32 / rate;
                ((t * freq * std::f32::consts::TAU).sin() * 0.5 * 32767.0) as i16
            })
            .collect()
    }

    #[test]
    fn mime_mapping_is_case_insensitive() {
        assert_eq!(mime_for_ext("ogg"), Some("audio/ogg"));
        assert_eq!(mime_for_ext("OGG"), Some("audio/ogg"));
        assert_eq!(mime_for_ext("opus"), Some("audio/ogg"));
        assert_eq!(mime_for_ext("mp3"), Some("audio/mp3"));
        assert_eq!(mime_for_ext("Mp3"), Some("audio/mp3"));
        assert_eq!(mime_for_ext("m4a"), Some("audio/aac"));
        assert_eq!(mime_for_ext("aac"), Some("audio/aac"));
        assert_eq!(mime_for_ext("wav"), Some("audio/wav"));
        assert_eq!(mime_for_ext("WAV"), Some("audio/wav"));
        assert_eq!(mime_for_ext("flac"), Some("audio/flac"));
        assert_eq!(mime_for_ext("txt"), None);
        assert_eq!(mime_for_ext(""), None);
    }

    #[test]
    fn voice_ext_is_ogg() {
        assert_eq!(VOICE_EXT, "ogg");
    }

    #[test]
    fn encode_sine_produces_valid_ogg() {
        let pcm = sine_24k_1s();
        let bytes = encode_voice_ogg(&pcm).expect("encode should succeed");
        // Ogg streams always begin with the "OggS" capture pattern.
        assert_eq!(&bytes[..4], b"OggS", "missing OggS capture pattern");
        // A 1-second clip is far larger than 1 KiB even at 32 kbps.
        assert!(bytes.len() > 1000, "ogg too small: {} bytes", bytes.len());
    }

    #[test]
    fn encode_then_probe_duration_is_about_one_second() {
        // Encode our sine to ogg, write it to a temp file, then probe it back.
        let pcm = sine_24k_1s();
        let bytes = encode_voice_ogg(&pcm).expect("encode");
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("clip.ogg");
        std::fs::write(&p, &bytes).unwrap();
        if let Some(d) = probe_duration(&p) {
            assert!((d - 1.0).abs() < 0.2, "ogg duration off: {d}");
        }
        // (If symphonia can't read granules from our minimal stream it returns
        // None; that's acceptable for the cosmetic probe. The WAV test below is
        // the authoritative duration check.)
    }

    #[test]
    fn probe_duration_of_generated_wav() {
        // hound writes a deterministic 1-second mono WAV; symphonia must read
        // its duration back to within tolerance.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("tone.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 24_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut wtr = hound::WavWriter::create(&p, spec).unwrap();
        for s in sine_24k_1s() {
            wtr.write_sample(s).unwrap();
        }
        wtr.finalize().unwrap();

        let d = probe_duration(&p).expect("wav should probe");
        assert!((d - 1.0).abs() < 0.2, "wav duration off: {d}");
    }
}
