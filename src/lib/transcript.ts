import type { TranscriptEvent } from "./ipc";

export interface TranscriptLine {
  id: number;
  direction: "in" | "out";
  original: string;
  translated: string;
  closed: boolean;
}

/**
 * Append a transcript fragment to the lines array.
 *
 * Rules:
 * - A direction change closes all lines of the OTHER direction.
 * - Fragment text is appended to the LAST open line of the same direction,
 *   or starts a new line if none is open.
 * - Returns a NEW array (immutable).
 */
export function appendTranscript(
  lines: TranscriptLine[],
  ev: TranscriptEvent,
  nextId: () => number
): TranscriptLine[] {
  // Close all lines of the opposite direction
  const result = lines.map((line) =>
    line.direction !== ev.direction && !line.closed
      ? { ...line, closed: true }
      : line
  );

  // Find the last open line for this direction
  const lastIdx = result.reduceRight(
    (found, line, idx) =>
      found === -1 && line.direction === ev.direction && !line.closed
        ? idx
        : found,
    -1
  );

  if (lastIdx === -1) {
    // No open line for this direction — start a new one
    const newLine: TranscriptLine = {
      id: nextId(),
      direction: ev.direction,
      original: ev.kind === "original" ? ev.text : "",
      translated: ev.kind === "translated" ? ev.text : "",
      closed: false,
    };
    return [...result, newLine];
  }

  // Append fragment to the existing open line
  const target = result[lastIdx];
  const updated: TranscriptLine =
    ev.kind === "original"
      ? { ...target, original: target.original + ev.text }
      : { ...target, translated: target.translated + ev.text };

  return [
    ...result.slice(0, lastIdx),
    updated,
    ...result.slice(lastIdx + 1),
  ];
}
