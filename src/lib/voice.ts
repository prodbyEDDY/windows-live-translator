/** Audio file extensions accepted for voice import. */
export const AUDIO_EXTS = new Set(["ogg", "opus", "mp3", "m4a", "aac", "wav", "flac"]);

/**
 * Splits a list of dropped paths into accepted audio files and rejected ones.
 * Case-insensitive extension check.
 */
export function filterAudioPaths(paths: string[]): {
  ok: string[];
  rejected: string[];
} {
  const ok: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (AUDIO_EXTS.has(ext)) {
      ok.push(p);
    } else {
      rejected.push(p);
    }
  }
  return { ok, rejected };
}

/**
 * Formats seconds as mm:ss (e.g. 65 → "01:05").
 * Thin alias over the shared {@link formatDuration} so the recording timer and
 * the Live/History timers all render identically.
 */
export { formatDuration as formatRecordingTime } from "./format";
