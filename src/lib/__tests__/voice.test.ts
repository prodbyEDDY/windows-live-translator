import { describe, it, expect } from "vitest";
import { filterAudioPaths, formatRecordingTime } from "../voice";

describe("filterAudioPaths", () => {
  it("accepts all supported audio extensions", () => {
    const paths = [
      "/tmp/a.ogg",
      "/tmp/b.opus",
      "/tmp/c.mp3",
      "/tmp/d.m4a",
      "/tmp/e.aac",
      "/tmp/f.wav",
      "/tmp/g.flac",
    ];
    const { ok, rejected } = filterAudioPaths(paths);
    expect(ok).toHaveLength(7);
    expect(rejected).toHaveLength(0);
  });

  it("rejects non-audio extensions", () => {
    const paths = ["/tmp/doc.pdf", "/tmp/image.png", "/tmp/notes.txt"];
    const { ok, rejected } = filterAudioPaths(paths);
    expect(ok).toHaveLength(0);
    expect(rejected).toEqual(paths);
  });

  it("is case-insensitive for extensions", () => {
    const paths = ["/tmp/a.OGG", "/tmp/b.MP3", "/tmp/c.WAV"];
    const { ok, rejected } = filterAudioPaths(paths);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it("handles a mixed list correctly", () => {
    const paths = ["/tmp/audio.mp3", "/tmp/photo.jpg", "/tmp/voice.ogg", "/tmp/doc.docx"];
    const { ok, rejected } = filterAudioPaths(paths);
    expect(ok).toEqual(["/tmp/audio.mp3", "/tmp/voice.ogg"]);
    expect(rejected).toEqual(["/tmp/photo.jpg", "/tmp/doc.docx"]);
  });

  it("handles empty input", () => {
    const { ok, rejected } = filterAudioPaths([]);
    expect(ok).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it("handles paths with no extension as rejected", () => {
    const { ok, rejected } = filterAudioPaths(["/tmp/noextension"]);
    expect(ok).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("handles paths with multiple dots correctly (uses last segment)", () => {
    const { ok, rejected } = filterAudioPaths(["/tmp/my.voice.message.mp3"]);
    expect(ok).toEqual(["/tmp/my.voice.message.mp3"]);
    expect(rejected).toHaveLength(0);
  });
});

describe("formatRecordingTime", () => {
  it("formats 0 seconds as 00:00", () => {
    expect(formatRecordingTime(0)).toBe("00:00");
  });

  it("formats 65 seconds as 01:05", () => {
    expect(formatRecordingTime(65)).toBe("01:05");
  });

  it("formats 300 seconds (5 min) as 05:00", () => {
    expect(formatRecordingTime(300)).toBe("05:00");
  });

  it("formats 59 seconds as 00:59", () => {
    expect(formatRecordingTime(59)).toBe("00:59");
  });
});
