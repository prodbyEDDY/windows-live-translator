import { langLabel } from "../lib/languages";

/**
 * Two-tone language-pair pill: left half cobalt («Вы»), right half tangerine
 * («Собеседник»), separated by a small arrow.
 */
export function LangPairPill({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center shrink-0 rounded-pill border border-hairline overflow-hidden text-[11px] font-medium leading-none">
      <span className="px-2 py-1 bg-cobalt-tint text-cobalt-deep font-mono">
        {langLabel(from)}
      </span>
      <span className="px-1 py-1 bg-stone-50 text-muted">→</span>
      <span className="px-2 py-1 bg-tangerine-tint text-tangerine-deep font-mono">
        {langLabel(to)}
      </span>
    </span>
  );
}
