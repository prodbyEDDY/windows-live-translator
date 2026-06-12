import type { Settings, LiveConfig } from "./ipc";

/** Vendor URLs (kept in sync with the Rust constants in `wizard.rs`). */
export const CABLE_PAGE_URL = "https://vb-audio.com/Cable/";
export const AI_STUDIO_URL = "https://aistudio.google.com/apikey";

/** The four wizard steps, in order. */
export const WIZARD_STEPS = ["key", "cable", "devices", "test"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Map a `wizard_install_cable` rejection to an i18n key.
 *
 * The Rust command rejects with prefixed strings (`download_failed: …`,
 * `installer_cancelled`, `installer_not_found_in_zip`, …). We key off the
 * prefix so the UI can show a localized message (and, for download failures,
 * offer the manual-download fallback).
 */
export function installErrorKey(err: string): string {
  if (err.startsWith("download_failed")) return "wizard.cable.errDownload";
  if (err.startsWith("installer_cancelled")) return "wizard.cable.errCancelled";
  if (err.startsWith("installer_not_found")) return "wizard.cable.errNoInstaller";
  return "wizard.cable.errGeneric";
}

/** True when a download failure should surface the "open vendor site" fallback. */
export function isDownloadError(err: string): boolean {
  return err.startsWith("download_failed");
}

/**
 * Build the test-mode LiveConfig from current settings.
 *
 * Test mode plays the OUT translation into the user's own output device and
 * skips the IN pipeline + virtual cable, so the user can hear their translated
 * voice before a real call. Forces `captureMode: "system"` and clears `appPid`.
 */
export function buildTestConfig(settings: Settings): LiveConfig {
  return {
    myLang: settings.myLang,
    peerLang: settings.peerLang,
    micId: settings.micId,
    outputId: settings.outputId,
    captureMode: "system",
    appPid: null,
    echoTargetLanguage: settings.echoTargetLanguage,
    duckingEnabled: settings.duckingEnabled,
    duckLevel: settings.duckLevel,
    testMode: true,
  };
}
