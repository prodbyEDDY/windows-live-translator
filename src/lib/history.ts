import type { TranscriptLine } from "./transcript";

/**
 * Returns true if a transcript has at least one line with non-empty text.
 * Used in LiveScreen to decide whether to persist the call.
 */
export function shouldSaveCall(lines: TranscriptLine[]): boolean {
  if (lines.length === 0) return false;
  return lines.some((l) => l.original.trim() !== "" || l.translated.trim() !== "");
}

/**
 * Parse transcript_json (array of TranscriptLine serialised by JSON.stringify)
 * and return a preview string (translated text preferred, fall back to original),
 * truncated to `max` characters with "…" appended when truncated.
 *
 * Returns "" on any parse error or when all lines are empty.
 */
export function previewText(transcriptJson: string, max: number): string {
  let lines: TranscriptLine[];
  try {
    const parsed = JSON.parse(transcriptJson);
    if (!Array.isArray(parsed)) return "";
    lines = parsed as TranscriptLine[];
  } catch {
    return "";
  }

  const joined = lines
    .map((l) => (l.translated && l.translated.trim() ? l.translated : l.original))
    .filter(Boolean)
    .join(" ")
    .trim();

  if (joined.length <= max) return joined;
  return joined.slice(0, max) + "…";
}
