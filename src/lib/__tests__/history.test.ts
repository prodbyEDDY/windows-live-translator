import { describe, it, expect } from "vitest";
import { shouldSaveCall, previewText } from "../history";
import type { TranscriptLine } from "../transcript";

// ---- shouldSaveCall ----

describe("shouldSaveCall", () => {
  it("returns false for empty array", () => {
    expect(shouldSaveCall([])).toBe(false);
  });

  it("returns false when all lines have empty text", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "", translated: "", closed: true },
      { id: 2, direction: "in", original: "   ", translated: "  ", closed: true },
    ];
    expect(shouldSaveCall(lines)).toBe(false);
  });

  it("returns true when at least one line has non-empty original", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "Hello", translated: "", closed: true },
    ];
    expect(shouldSaveCall(lines)).toBe(true);
  });

  it("returns true when at least one line has non-empty translated", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "in", original: "", translated: "Привет", closed: false },
    ];
    expect(shouldSaveCall(lines)).toBe(true);
  });

  it("returns true for a normal mixed transcript", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "Hi", translated: "Привет", closed: true },
      { id: 2, direction: "in", original: "Как дела?", translated: "How are you?", closed: false },
    ];
    expect(shouldSaveCall(lines)).toBe(true);
  });
});

// ---- previewText ----

describe("previewText", () => {
  it("returns empty string for broken JSON", () => {
    expect(previewText("{not json", 80)).toBe("");
  });

  it("returns empty string for non-array JSON", () => {
    expect(previewText('{"foo":"bar"}', 80)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(previewText("[]", 80)).toBe("");
  });

  it("returns joined translated text when available", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "Привет", translated: "Hello", closed: true },
      { id: 2, direction: "in", original: "Hello", translated: "Привет", closed: true },
    ];
    const json = JSON.stringify(lines);
    expect(previewText(json, 200)).toBe("Hello Привет");
  });

  it("falls back to original when translated is empty", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "Hey there", translated: "", closed: true },
    ];
    expect(previewText(JSON.stringify(lines), 200)).toBe("Hey there");
  });

  it("truncates at max characters and appends ellipsis", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "Hello world this is a long message", translated: "", closed: true },
    ];
    const result = previewText(JSON.stringify(lines), 10);
    expect(result).toBe("Hello worl…");
    expect(result.length).toBe(11); // 10 chars + "…"
  });

  it("does not truncate when text is exactly max characters", () => {
    const text = "1234567890";
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: text, translated: "", closed: true },
    ];
    const result = previewText(JSON.stringify(lines), 10);
    expect(result).toBe(text);
  });

  it("returns empty string when all lines have empty text", () => {
    const lines: TranscriptLine[] = [
      { id: 1, direction: "out", original: "", translated: "", closed: true },
    ];
    expect(previewText(JSON.stringify(lines), 80)).toBe("");
  });
});
