import { describe, it, expect } from "vitest";
import {
  looksLikeHeadphones,
  looksLikeSpeakers,
  isLoopbackCaptureDevice,
} from "../echo";

describe("looksLikeHeadphones", () => {
  it("matches headphone/headset names (RU + EN)", () => {
    expect(looksLikeHeadphones("Headphones (Realtek Audio)")).toBe(true);
    expect(looksLikeHeadphones("Наушники (Realtek)")).toBe(true);
    expect(looksLikeHeadphones("Headset Earphone")).toBe(true);
    expect(looksLikeHeadphones("WH-1000XM4 (Bluetooth)")).toBe(false); // model-named BT
    expect(looksLikeHeadphones(null)).toBe(false);
  });
});

describe("looksLikeSpeakers", () => {
  it("flags loudspeaker endpoints (Windows includes the form-factor word)", () => {
    expect(looksLikeSpeakers("Speakers (Realtek High Definition Audio)")).toBe(true);
    expect(looksLikeSpeakers("Динамики (Realtek)")).toBe(true);
    expect(looksLikeSpeakers("Колонки")).toBe(true);
    // Headphones must NOT read as speakers (no false echo warning).
    expect(looksLikeSpeakers("Headphones (Realtek Audio)")).toBe(false);
    expect(looksLikeSpeakers("Наушники")).toBe(false);
    expect(looksLikeSpeakers(undefined)).toBe(false);
  });
});

describe("isLoopbackCaptureDevice", () => {
  it("detects render-loopback / monitor mixes that must not be used as a mic", () => {
    expect(isLoopbackCaptureDevice("CABLE Output (VB-Audio Virtual Cable)")).toBe(true);
    expect(isLoopbackCaptureDevice("Stereo Mix (Realtek(R) Audio)")).toBe(true);
    expect(isLoopbackCaptureDevice("Стерео микшер")).toBe(true);
    expect(isLoopbackCaptureDevice("What U Hear")).toBe(true);
    // Real microphones pass through.
    expect(isLoopbackCaptureDevice("Microphone (USB Audio Device)")).toBe(false);
    expect(isLoopbackCaptureDevice("Микрофон (Realtek)")).toBe(false);
    expect(isLoopbackCaptureDevice(null)).toBe(false);
  });
});
