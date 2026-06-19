import { describe, it, expect } from "vitest";
import {
  installErrorKey,
  isDownloadError,
  buildTestConfig,
  WIZARD_STEPS,
} from "../wizard";
import type { Settings } from "../ipc";

describe("installErrorKey", () => {
  it("maps download failures (with detail suffix)", () => {
    expect(installErrorKey("download_failed: HTTP 503")).toBe(
      "wizard.cable.errDownload"
    );
  });
  it("maps a cancelled install", () => {
    expect(installErrorKey("installer_cancelled")).toBe(
      "wizard.cable.errCancelled"
    );
  });
  it("maps a missing installer", () => {
    expect(installErrorKey("installer_not_found_in_zip")).toBe(
      "wizard.cable.errNoInstaller"
    );
  });
  it("falls back to a generic key for unknown errors", () => {
    expect(installErrorKey("something else")).toBe("wizard.cable.errGeneric");
  });
});

describe("isDownloadError", () => {
  it("is true only for download failures", () => {
    expect(isDownloadError("download_failed: timeout")).toBe(true);
    expect(isDownloadError("installer_cancelled")).toBe(false);
  });
});

describe("buildTestConfig", () => {
  const base: Settings = {
    myLang: "ru",
    peerLang: "en",
    voiceMyLang: "ru",
    voicePeerLang: "en",
    micId: "mic-1",
    outputId: "out-1",
    voiceMicId: null,
    captureMode: "app",
    echoTargetLanguage: true,
    duckingEnabled: true,
    duckLevel: 40,
    mixOriginal: false,
    mixGainDb: -6,
    vadEconomy: true,
    uiLang: "ru",
    wizardDone: false,
    ttsVoice: "Puck",
    ttsProvider: "gemini",
    elevenVoiceId: "",
    idlePassthrough: true,
    idleAutoStop: true,
    settingsSchemaVersion: 1,
  };

  it("forces test mode, system capture, and clears appPid", () => {
    const cfg = buildTestConfig(base);
    expect(cfg.testMode).toBe(true);
    expect(cfg.captureMode).toBe("system");
    expect(cfg.appPid).toBeNull();
  });

  it("keeps VAD economy off in test mode regardless of the saved setting", () => {
    const cfg = buildTestConfig(base);
    expect(cfg.vadEconomy).toBe(false);
  });

  it("carries through language and device settings", () => {
    const cfg = buildTestConfig(base);
    expect(cfg.myLang).toBe("ru");
    expect(cfg.peerLang).toBe("en");
    expect(cfg.micId).toBe("mic-1");
    expect(cfg.outputId).toBe("out-1");
    expect(cfg.echoTargetLanguage).toBe(true);
    expect(cfg.duckLevel).toBe(40);
  });
});

describe("WIZARD_STEPS", () => {
  it("has the four steps in order", () => {
    expect(WIZARD_STEPS).toEqual(["key", "cable", "devices", "test"]);
  });
});
