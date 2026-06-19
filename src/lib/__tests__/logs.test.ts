import { describe, it, expect } from "vitest";
import { filterLogs, formatLogLine, levelRank, type LogEntry } from "../logs";

function e(partial: Partial<LogEntry>): LogEntry {
  return {
    seq: 1,
    ts: "2026-06-19T14:03:11.482+03:00",
    level: "INFO",
    target: "voice",
    message: "hello",
    fields: {},
    ...partial,
  };
}

describe("levelRank", () => {
  it("orders severities ERROR > WARN > INFO > DEBUG > TRACE", () => {
    expect(levelRank("ERROR")).toBeGreaterThan(levelRank("WARN"));
    expect(levelRank("WARN")).toBeGreaterThan(levelRank("INFO"));
    expect(levelRank("INFO")).toBeGreaterThan(levelRank("DEBUG"));
    expect(levelRank("DEBUG")).toBeGreaterThan(levelRank("TRACE"));
  });

  it("treats unknown levels as INFO", () => {
    expect(levelRank("weird")).toBe(levelRank("INFO"));
  });
});

describe("filterLogs", () => {
  const entries = [
    e({ seq: 1, level: "INFO", target: "voice", message: "queued" }),
    e({
      seq: 2,
      level: "ERROR",
      target: "elevenlabs",
      message: "TTS failed",
      fields: { code: "detected_unusual_activity" },
    }),
    e({ seq: 3, level: "DEBUG", target: "gemini", message: "latency" }),
  ];

  it("filters by minimum level", () => {
    const r = filterLogs(entries, { minLevel: "ERROR", query: "" });
    expect(r.map((x) => x.seq)).toEqual([2]);
  });

  it("filters by query across message, target, and field values", () => {
    expect(filterLogs(entries, { minLevel: "TRACE", query: "elevenlabs" }).map((x) => x.seq)).toEqual([2]);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "unusual" }).map((x) => x.seq)).toEqual([2]);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "queued" }).map((x) => x.seq)).toEqual([1]);
  });

  it("query is case-insensitive and empty matches all", () => {
    expect(filterLogs(entries, { minLevel: "TRACE", query: "" }).length).toBe(3);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "TTS" }).map((x) => x.seq)).toEqual([2]);
  });
});

describe("formatLogLine", () => {
  it("includes ts, level, target, message and fields", () => {
    const line = formatLogLine(
      e({ level: "WARN", target: "elevenlabs", message: "x", fields: { httpStatus: 401 } })
    );
    expect(line).toContain("WARN");
    expect(line).toContain("elevenlabs");
    expect(line).toContain("httpStatus=401");
  });

  it("omits the field separator when there are no fields", () => {
    expect(formatLogLine(e({ fields: {} }))).not.toContain(" | ");
  });
});
