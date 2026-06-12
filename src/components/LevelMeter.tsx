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

interface LevelMeterProps {
  db: number;
  label: string;
}

export function LevelMeter({ db, label }: LevelMeterProps) {
  const pct = dbToPercent(db);

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-gray-500 flex-shrink-0 w-7">{label}</span>
      <div
        className="flex-1 h-2 rounded-full bg-gray-200 overflow-hidden"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-all duration-75"
          style={{
            width: `${pct}%`,
            background:
              pct < 60
                ? "#22c55e"
                : pct < 80
                ? "#eab308"
                : "#ef4444",
          }}
        />
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0 w-10 text-right tabular-nums">
        {db <= DB_MIN ? `≤${DB_MIN}` : db === DB_MAX ? "0"  : db.toFixed(0)} dB
      </span>
    </div>
  );
}
