import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app";
import { langLabel } from "../lib/languages";
import type { TranscriptLine } from "../lib/transcript";

interface TranscriptFeedProps {
  lines: TranscriptLine[];
}

export function TranscriptFeed({ lines }: TranscriptFeedProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Autoscroll when pinned and new content arrives
  useEffect(() => {
    if (pinned && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, pinned]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    setPinned(atBottom);
  }

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    setPinned(true);
  }

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center select-none px-6">
        <span className="font-display text-[64px] leading-none text-stone-200">⇄</span>
        <p className="text-[13px] text-muted max-w-xs">{t("live.transcriptEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto flex flex-col gap-2.5 p-4"
      >
        {lines.map((line) => (
          <TranscriptBubble key={line.id} line={line} />
        ))}
      </div>

      {/* Scroll-to-bottom button */}
      {!pinned && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={scrollToBottom}
            className="px-3.5 h-8 rounded-pill bg-surface border border-hairline shadow-studio text-[12px] text-ink hover:border-stone-300 transition-colors"
          >
            {t("live.scrollDown")}
          </button>
        </div>
      )}
    </div>
  );
}

function TranscriptBubble({ line }: { line: TranscriptLine }) {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const isOut = line.direction === "out";

  // Direction routing label: «Вы → EN» / «Собеседник → RU»
  const targetLang = isOut ? settings?.peerLang : settings?.myLang;
  const who = isOut ? t("live.sessionOutLabel") : t("live.sessionInLabel");
  const routeLabel = `${who} → ${targetLang ? langLabel(targetLang) : "—"}`;

  const accent = isOut ? "var(--color-cobalt)" : "var(--color-tangerine)";
  const bg = isOut ? "bg-cobalt-tint" : "bg-tangerine-tint";
  const labelColor = isOut ? "text-cobalt-deep" : "text-tangerine-deep";

  const primary = line.translated || line.original;
  const hasSub = !!(line.translated && line.original);

  return (
    <div className={`flex flex-col ${isOut ? "items-end" : "items-start"}`}>
      <div
        className={`lt-bubble-in max-w-[72%] rounded-card pl-3.5 pr-4 py-2.5 ${bg}`}
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        <span
          className={`block text-[10.5px] font-medium uppercase tracking-[0.08em] mb-1 ${labelColor}`}
        >
          {routeLabel}
        </span>
        <p className="text-[15px] leading-[1.5] text-ink">{primary}</p>
        {hasSub && (
          <p className="text-[12.5px] leading-[1.45] text-muted mt-1">
            {line.original}
          </p>
        )}
      </div>
    </div>
  );
}
