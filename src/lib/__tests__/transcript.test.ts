import { describe, it, expect } from "vitest";
import {
  appendTranscript,
  appendTranscriptMut,
  type TranscriptLine,
} from "../transcript";
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

describe("appendTranscript — close events", () => {
  it("close marks the last open line of that direction closed (no new line)", () => {
    reset();
    const r1 = appendTranscript(
      [],
      { direction: "out", kind: "original", text: "Hi" },
      nextId
    );
    const r2 = appendTranscript(
      r1,
      { direction: "out", kind: "close", text: "" },
      nextId
    );
    expect(r2).toHaveLength(1);
    expect(r2[0].closed).toBe(true);
    expect(r2[0].original).toBe("Hi");
    // immutable — original array untouched
    expect(r1[0].closed).toBe(false);
  });

  it("close → next same-direction fragment opens a NEW line", () => {
    reset();
    const r1 = appendTranscript(
      [],
      { direction: "out", kind: "original", text: "A" },
      nextId
    );
    const r2 = appendTranscript(
      r1,
      { direction: "out", kind: "close", text: "" },
      nextId
    );
    const r3 = appendTranscript(
      r2,
      { direction: "out", kind: "original", text: "B" },
      nextId
    );
    expect(r3).toHaveLength(2);
    expect(r3[0].closed).toBe(true);
    expect(r3[0].original).toBe("A");
    expect(r3[1].closed).toBe(false);
    expect(r3[1].original).toBe("B");
  });

  it("close with no open line of that direction is a no-op", () => {
    reset();
    // empty array
    const empty: TranscriptLine[] = [];
    const r0 = appendTranscript(
      empty,
      { direction: "out", kind: "close", text: "" },
      nextId
    );
    expect(r0).toBe(empty); // same reference — true no-op

    // an already-closed line of that direction
    const r1 = appendTranscript(
      [],
      { direction: "in", kind: "original", text: "X" },
      nextId
    );
    const closed = appendTranscript(
      r1,
      { direction: "in", kind: "close", text: "" },
      nextId
    );
    const again = appendTranscript(
      closed,
      { direction: "in", kind: "close", text: "" },
      nextId
    );
    expect(again).toBe(closed); // no open "in" line → no-op
  });
});

describe("appendTranscriptMut mirrors appendTranscript", () => {
  it("produces identical output for a mixed fragment sequence (incl. close)", () => {
    const events: TranscriptEvent[] = [
      { direction: "out", kind: "original", text: "Прив" },
      { direction: "out", kind: "original", text: "ет" },
      { direction: "out", kind: "translated", text: "Hello" },
      { direction: "out", kind: "close", text: "" },
      { direction: "in", kind: "original", text: "Hi " },
      { direction: "in", kind: "original", text: "there" },
      { direction: "in", kind: "translated", text: "Привет" },
      { direction: "in", kind: "close", text: "" },
      { direction: "out", kind: "original", text: "Bye" },
      { direction: "out", kind: "translated", text: "Пока" },
    ];

    // Immutable reference run.
    let immSeq = 0;
    const immNextId = () => ++immSeq;
    let imm: TranscriptLine[] = [];
    for (const ev of events) imm = appendTranscript(imm, ev, immNextId);

    // Mutating run.
    let mutSeq = 0;
    const mutNextId = () => ++mutSeq;
    const mut: TranscriptLine[] = [];
    for (const ev of events) appendTranscriptMut(mut, ev, mutNextId);

    expect(mut).toEqual(imm);
  });

  it("mutating helper edits in place (same array reference returned)", () => {
    let seqM = 0;
    const idM = () => ++seqM;
    const arr: TranscriptLine[] = [];
    const ret = appendTranscriptMut(
      arr,
      { direction: "out", kind: "original", text: "x" },
      idM
    );
    expect(ret).toBe(arr);
    expect(arr).toHaveLength(1);
  });
});
