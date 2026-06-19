// Store-level tests for app lifecycle hardening (audit findings).
//
// `../lib/ipc` is mocked so we can drive success/rejection paths without a
// Tauri backend. We import the store AFTER the mock is registered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mutable mock for the ipc surface — individual tests override methods.
const settingsSet = vi.fn();
const liveStop = vi.fn(() => Promise.resolve());

vi.mock("../../lib/ipc", () => ({
  ipc: {
    settingsSet: (...args: unknown[]) => settingsSet(...args),
    liveStop: () => liveStop(),
    // Unused by these tests but referenced by the module surface.
    settingsGet: vi.fn(() => Promise.resolve(null)),
    apiKeyStatus: vi.fn(() => Promise.resolve({ state: "missing" })),
    devicesList: vi.fn(() =>
      Promise.resolve({ inputs: [], outputs: [], cablePresent: false })
    ),
  },
}));

import { useAppStore, deriveErrorReason } from "../app";
import type { Settings } from "../../lib/ipc";

const BASE_SETTINGS: Settings = {
  myLang: "ru",
  peerLang: "en",
  voiceMyLang: "ru",
  voicePeerLang: "en",
  micId: "mic-1",
  outputId: null,
  voiceMicId: null,
  captureMode: "system",
  echoTargetLanguage: false,
  duckingEnabled: false,
  duckLevel: 50,
  mixOriginal: false,
  mixGainDb: -12,
  vadEconomy: false,
  uiLang: "ru",
  wizardDone: true,
  ttsVoice: "Kore",
  ttsProvider: "gemini",
  elevenVoiceId: "",
  idlePassthrough: true,
  idleAutoStop: true,
  settingsSchemaVersion: 1,
};

beforeEach(() => {
  settingsSet.mockReset();
  liveStop.mockClear();
  useAppStore.setState({
    settings: { ...BASE_SETTINGS },
    lastError: null,
    starting: false,
    durationSec: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("patchSettings", () => {
  it("commits the backend-returned settings on success", async () => {
    settingsSet.mockResolvedValueOnce({ ...BASE_SETTINGS, micId: "mic-2" });
    await useAppStore.getState().patchSettings({ micId: "mic-2" });
    expect(useAppStore.getState().settings?.micId).toBe("mic-2");
    expect(useAppStore.getState().lastError).toBeNull();
  });

  it("rolls back the optimistic update and sets lastError on rejection", async () => {
    settingsSet.mockRejectedValueOnce("backend_rejected");
    await useAppStore.getState().patchSettings({ micId: "mic-bogus" });
    // Optimistic value must be reverted to the pre-patch settings.
    expect(useAppStore.getState().settings?.micId).toBe("mic-1");
    expect(useAppStore.getState().lastError).toContain("backend_rejected");
  });
});

describe("startLiveSession re-entrancy", () => {
  it("returns early when a start is already in flight", async () => {
    useAppStore.setState({ starting: true });
    const before = useAppStore.getState().transcript;
    await useAppStore.getState().startLiveSession();
    // No work should have happened (transcript not cleared/replaced).
    expect(useAppStore.getState().transcript).toBe(before);
    expect(useAppStore.getState().starting).toBe(true);
  });
});

describe("deriveErrorReason", () => {
  it("flags source_lost via the sentinel key", () => {
    expect(
      deriveErrorReason({ outSession: "source_lost", inSession: "off" })
    ).toBe("__sourceLost__");
  });

  it("returns the raw unknown direction state", () => {
    expect(
      deriveErrorReason({ outSession: "running", inSession: "boom: detail" })
    ).toBe("boom: detail");
  });

  it("returns null when both sides are known/healthy", () => {
    expect(
      deriveErrorReason({ outSession: "running", inSession: "off" })
    ).toBeNull();
  });
});
