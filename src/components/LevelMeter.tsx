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

/**
 * Compact 24-segment level meter rendered as a single rounded bar that fills by
 * width in the direction color. Used in the Live status strip.
 */
export function DirectionMeter({ db, tone, label }: DirectionMeterProps) {
  const pct = dbToPercent(db);
  const color = tone === "out" ? "var(--color-cobalt)" : "var(--color-tangerine)";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[10.5px] font-medium text-muted w-9 shrink-0 truncate">
        {label}
      </span>
      <div
        className="relative h-[3px] w-24 rounded-pill bg-stone-200 overflow-hidden"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-pill transition-[width] duration-100 ease-out"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
