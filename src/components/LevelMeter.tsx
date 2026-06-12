const DB_MIN = -60;
const DB_MAX = 0;

/**
 * Maps a dB value to a 0–100 percentage for display.
 * Clamps values outside the -60..0 range.
 */
export function dbToPercent(db: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db));
  return ((clamped - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
}

interface DirectionMeterProps {
  db: number;
  /** "out" = cobalt (you), "in" = tangerine (peer). */
  tone: "out" | "in";
  label: string;
}

const SEGMENTS = 5;

/**
 * Compact discrete level meter: 5 segments (2px gap), filled in the direction
 * color by level. Calmer than a continuous bar. Used in the Live status strip.
 */
export function DirectionMeter({ db, tone, label }: DirectionMeterProps) {
  const pct = dbToPercent(db);
  const color = tone === "out" ? "var(--color-cobalt)" : "var(--color-tangerine)";
  // How many of the 5 segments are lit.
  const lit = Math.round((pct / 100) * SEGMENTS);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-[11px] font-medium text-stone-500 w-8 shrink-0 truncate tabular-nums uppercase tracking-tight">
        {label}
      </span>
      <div
        className="flex items-center gap-[2px]"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {Array.from({ length: SEGMENTS }).map((_, i) => (
          <span
            key={i}
            className="h-2.5 w-2 rounded-[1.5px] transition-colors duration-100 ease-out"
            style={{
              background: i < lit ? color : "var(--color-hairline)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
