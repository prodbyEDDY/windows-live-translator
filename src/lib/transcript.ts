import type { TranscriptEvent } from "./ipc";

export interface TranscriptLine {
  id: number;
  direction: "in" | "out";
  original: string;
  translated: string;
  closed: boolean;
}

/** Index of the last OPEN line of `direction`, or -1 if none. */
function lastOpenIdx(
  lines: TranscriptLine[],
  direction: "in" | "out"
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.direction === direction && !line.closed) return i;
  }
  return -1;
}

/**
 * Append a transcript fragment to the lines array.
 *
 * Rules:
 * - kind "close": mark the last OPEN line of `direction` as closed (immutably)
 *   and return — never starts a new line. A no-op when no line is open.
 * - A direction change closes all lines of the OTHER direction.
 * - Fragment text is appended to the LAST open line of the same direction,
 *   or starts a new line if none is open.
 * - Returns a NEW array (immutable).
 *
 * Fast path: when the fragment lands on the LAST line of the array (the
 * overwhelmingly common case) we skip the full `lines.map` over every line and
 * copy only the affected tail. This is sound because a direction switch always
 * closes the opposite direction, so whenever the last line is the current
 * direction and still open, there are no open opposite-direction lines left to
 * close — the close-other-direction map would be a no-op anyway.
 */
export function appendTranscript(
  lines: TranscriptLine[],
  ev: TranscriptEvent,
  nextId: () => number
): TranscriptLine[] {
  // ---- kind "close": close the last open line of this direction, no new line.
  if (ev.kind === "close") {
    const idx = lastOpenIdx(lines, ev.direction);
    if (idx === -1) return lines; // no open line — no-op
    const closed = { ...lines[idx], closed: true };
    return [...lines.slice(0, idx), closed, ...lines.slice(idx + 1)];
  }

  // ---- Fast path: append onto the LAST line when it's our open direction.
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  if (last && last.direction === ev.direction && !last.closed) {
    const updatedLast: TranscriptLine =
      ev.kind === "original"
        ? { ...last, original: last.original + ev.text }
        : { ...last, translated: last.translated + ev.text };
    return [...lines.slice(0, -1), updatedLast];
  }

  // ---- Slow path: direction may have changed — close all opposite-direction
  // open lines, then append to / open the same-direction line.
  const result = lines.map((line) =>
    line.direction !== ev.direction && !line.closed
      ? { ...line, closed: true }
      : line
  );

  const lastIdx = lastOpenIdx(result, ev.direction);

  if (lastIdx === -1) {
    // No open line for this direction — start a new one.
    const newLine: TranscriptLine = {
      id: nextId(),
      direction: ev.direction,
      original: ev.kind === "original" ? ev.text : "",
      translated: ev.kind === "translated" ? ev.text : "",
      closed: false,
    };
    return [...result, newLine];
  }

  // Append fragment to the existing open line.
  const target = result[lastIdx];
  const updated: TranscriptLine =
    ev.kind === "original"
      ? { ...target, original: target.original + ev.text }
      : { ...target, translated: target.translated + ev.text };

  return [...result.slice(0, lastIdx), updated, ...result.slice(lastIdx + 1)];
}

/**
 * Mutating mirror of {@link appendTranscript} for the FULL (un-capped)
 * transcript kept outside the store. Same semantics, but pushes / edits in
 * place to avoid re-allocating the whole array on every fragment. Never
 * triggers a React render (the array is module-scoped, not store state).
 *
 * Returns the same array reference for convenience.
 */
export function appendTranscriptMut(
  lines: TranscriptLine[],
  ev: TranscriptEvent,
  nextId: () => number
): TranscriptLine[] {
  if (ev.kind === "close") {
    const idx = lastOpenIdx(lines, ev.direction);
    if (idx !== -1) lines[idx] = { ...lines[idx], closed: true };
    return lines;
  }

  // Direction change closes all open opposite-direction lines in place.
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  const sameOpenLast =
    last && last.direction === ev.direction && !last.closed;
  if (!sameOpenLast) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.direction !== ev.direction && !line.closed) {
        lines[i] = { ...line, closed: true };
      }
    }
  }

  const idx = lastOpenIdx(lines, ev.direction);
  if (idx === -1) {
    lines.push({
      id: nextId(),
      direction: ev.direction,
      original: ev.kind === "original" ? ev.text : "",
      translated: ev.kind === "translated" ? ev.text : "",
      closed: false,
    });
    return lines;
  }

  const target = lines[idx];
  lines[idx] =
    ev.kind === "original"
      ? { ...target, original: target.original + ev.text }
      : { ...target, translated: target.translated + ev.text };
  return lines;
}
