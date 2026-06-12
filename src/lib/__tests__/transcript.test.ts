import { describe, it, expect } from "vitest";
import { appendTranscript, type TranscriptLine } from "../transcript";
import type { TranscriptEvent } from "../ipc";

let seq = 0;
function nextId() {
  return ++seq;
}

function reset() {
  seq = 0;
}

describe("appendTranscript", () => {
  it("creates a new line for the first fragment", () => {
    reset();
    const ev: TranscriptEvent = { direction: "out", kind: "original", text: "Hello" };
    const result = appendTranscript([], ev, nextId);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("out");
    expect(result[0].original).toBe("Hello");
    expect(result[0].translated).toBe("");
    expect(result[0].closed).toBe(false);
  });

  it("accumulates fragments in the same direction into the same line", () => {
    reset();
    const lines: TranscriptLine[] = [];
    const ev1: TranscriptEvent = { direction: "out", kind: "original", text: "Hel" };
    const ev2: TranscriptEvent = { direction: "out", kind: "original", text: "lo " };
    const ev3: TranscriptEvent = { direction: "out", kind: "original", text: "world" };
    const r1 = appendTranscript(lines, ev1, nextId);
    const r2 = appendTranscript(r1, ev2, nextId);
    const r3 = appendTranscript(r2, ev3, nextId);
    expect(r3).toHaveLength(1);
    expect(r3[0].original).toBe("Hello world");
  });

  it("original and translated fragments land in the same line", () => {
    reset();
    const ev1: TranscriptEvent = { direction: "out", kind: "original", text: "Привет" };
    const ev2: TranscriptEvent = { direction: "out", kind: "translated", text: "Hello" };
    const r1 = appendTranscript([], ev1, nextId);
    const r2 = appendTranscript(r1, ev2, nextId);
    expect(r2).toHaveLength(1);
    expect(r2[0].original).toBe("Привет");
    expect(r2[0].translated).toBe("Hello");
    expect(r2[0].closed).toBe(false);
  });

  it("direction switch closes the previous direction line and opens a new one", () => {
    reset();
    const ev1: TranscriptEvent = { direction: "out", kind: "original", text: "Hi" };
    const r1 = appendTranscript([], ev1, nextId);

    const ev2: TranscriptEvent = { direction: "in", kind: "original", text: "Hello" };
    const r2 = appendTranscript(r1, ev2, nextId);

    expect(r2).toHaveLength(2);
    expect(r2[0].direction).toBe("out");
    expect(r2[0].closed).toBe(true);
    expect(r2[1].direction).toBe("in");
    expect(r2[1].closed).toBe(false);
    expect(r2[1].original).toBe("Hello");
  });

  it("continuing the same direction after a switch appends to the open line", () => {
    reset();
    const r1 = appendTranscript(
      [],
      { direction: "out", kind: "original", text: "A" },
      nextId
    );
    const r2 = appendTranscript(
      r1,
      { direction: "in", kind: "original", text: "B" },
      nextId
    );
    // Now back to "out" — should open a NEW line since previous "out" is closed
    const r3 = appendTranscript(
      r2,
      { direction: "out", kind: "original", text: "C" },
      nextId
    );
    expect(r3).toHaveLength(3);
    expect(r3[2].direction).toBe("out");
    expect(r3[2].original).toBe("C");
    expect(r3[2].closed).toBe(false);
    // in-line was closed when we switched back to out
    expect(r3[1].closed).toBe(true);
  });

  it("does not mutate the original lines array", () => {
    reset();
    const original: TranscriptLine[] = [];
    const ev: TranscriptEvent = { direction: "out", kind: "original", text: "X" };
    const result = appendTranscript(original, ev, nextId);
    expect(original).toHaveLength(0);
    expect(result).toHaveLength(1);
  });
});
