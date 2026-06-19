/** A captured backend log entry (camelCase mirror of `logbus::LogEntry`). */
export interface LogEntry {
  seq: number;
  ts: string;
  level: string;
  target: string;
  message: string;
  fields: Record<string, unknown>;
}

/** Severity order, lowest → highest. */
export const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;
export type Level = (typeof LEVELS)[number];

/** Numeric rank of a level (higher = more severe); unknown levels rank as INFO. */
export function levelRank(level: string): number {
  const i = LEVELS.indexOf(level.toUpperCase() as Level);
  return i === -1 ? LEVELS.indexOf("INFO") : i;
}

export interface LogFilter {
  /** Minimum severity to include. */
  minLevel: string;
  /** Case-insensitive substring matched against message, target, and field values. */
  query: string;
}

/** Filter entries by minimum level and a free-text query. */
export function filterLogs(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  const min = levelRank(filter.minLevel);
  const q = filter.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (levelRank(e.level) < min) return false;
    if (!q) return true;
    if (e.message.toLowerCase().includes(q)) return true;
    if (e.target.toLowerCase().includes(q)) return true;
    return Object.entries(e.fields).some(
      ([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)
    );
  });
}

/** One-line plain-text rendering (used for display + clipboard). */
export function formatLogLine(e: LogEntry): string {
  let s = `${e.ts}  ${e.level.padEnd(5)}  ${e.target}  ${e.message}`;
  const keys = Object.keys(e.fields);
  if (keys.length > 0) {
    s += "  | " + keys.map((k) => `${k}=${String(e.fields[k])}`).join(" ");
  }
  return s;
}
