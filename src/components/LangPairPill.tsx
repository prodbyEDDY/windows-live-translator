import { langLabel } from "../lib/languages";

/**
 * Two-tone language-pair pill: left half cobalt («Вы»), right half tangerine
 * («Собеседник»), separated by a small arrow.
 */
export function LangPairPill({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center shrink-0 h-6 rounded-pill border border-hairline overflow-hidden text-[10px] font-semibold leading-none tracking-[0.04em]">
      <span className="px-2 h-full inline-flex items-center bg-cobalt-tint text-cobalt-deep font-mono">
        {langLabel(from)}
      </span>
      <span className="px-1 h-full inline-flex items-center bg-stone-50 text-stone-400">→</span>
      <span className="px-2 h-full inline-flex items-center bg-tangerine-tint text-tangerine-deep font-mono">
        {langLabel(to)}
      </span>
    </span>
  );
}
