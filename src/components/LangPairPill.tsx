import { langLabel } from "../lib/languages";

/**
 * Language-pair pill: source («Вы») carries the single cobalt accent, target
 * («Собеседник») is a quiet neutral fill. Direction is read from the arrow and
 * left-to-right order — no second hue.
 */
export function LangPairPill({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center shrink-0 h-6 rounded-pill border border-hairline overflow-hidden text-label font-semibold leading-none">
      <span className="px-2 h-full inline-flex items-center bg-cobalt-tint text-cobalt-deep font-mono">
        {langLabel(from)}
      </span>
      <span
        aria-hidden="true"
        className="px-1 h-full inline-flex items-center bg-surface text-muted"
      >
        →
      </span>
      <span className="px-2 h-full inline-flex items-center bg-surface-2 text-ink-2 font-mono">
        {langLabel(to)}
      </span>
    </span>
  );
}
