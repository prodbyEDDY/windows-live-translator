import type { KeyStatus } from "./ipc";

export interface CanStartResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pure function that determines whether the Start button should be enabled.
 * Returns { ok: true } when all conditions are met, or { ok: false, reason }
 * with an i18n key for the blocking reason.
 */
export function canStart(
  keyStatus: KeyStatus | null,
  captureMode: "app" | "system",
  appPid: number | null,
  cablePresent: boolean
): CanStartResult {
  if (!keyStatus || keyStatus.state !== "valid") {
    return { ok: false, reason: "live.startBlockedNoKey" };
  }
  if (!cablePresent) {
    return { ok: false, reason: "live.startBlockedNoCable" };
  }
  if (captureMode === "app" && appPid == null) {
    return { ok: false, reason: "live.startBlockedNoApp" };
  }
  return { ok: true };
}
