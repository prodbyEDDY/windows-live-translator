import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app";
import { langLabel } from "../lib/languages";
import type { TranscriptLine } from "../lib/transcript";

interface TranscriptFeedProps {
  lines: TranscriptLine[];
}

function TranscriptFeedImpl({ lines }: TranscriptFeedProps) {
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
    return <TranscriptEmpty />;
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto flex flex-col px-5 py-4"
      >
        {lines.map((line, i) => (
          <TranscriptBubble
            key={line.id}
            line={line}
            prevDirection={i > 0 ? lines[i - 1].direction : null}
          />
        ))}
      </div>

      {/* Scroll-to-bottom button */}
      {!pinned && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={scrollToBottom}
            className="lt-press lt-card px-3.5 h-8 rounded-pill bg-surface border border-hairline text-[12px] text-ink hover:border-stone-300"
          >
            {t("live.scrollDown")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Memoized so the 10Hz status-strip re-renders (levels/cost) in LiveScreen
 * can't force a transcript re-render — it only re-renders when `lines` changes.
 */
export const TranscriptFeed = memo(TranscriptFeedImpl);

/** Empty-state with oversized glyph + one-line hint + a 3-step stepper. */
function TranscriptEmpty() {
  const { t } = useTranslation();
  const steps = [
    t("live.empty.step1"),
    t("live.empty.step2"),
    t("live.empty.step3"),
  ];
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center select-none px-6">
      <span className="font-display text-[72px] leading-none text-stone-200">⇄</span>
      <p className="text-[13px] text-muted max-w-xs leading-relaxed">
        {t("live.transcriptEmpty")}
      </p>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-stone-100 border border-hairline font-mono text-[9px] text-stone-400">
                {i + 1}
              </span>
              <span>{step}</span>
            </span>
            {i < steps.length - 1 && (
              <span className="text-stone-300">→</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function TranscriptBubble({
  line,
  prevDirection,
}: {
  line: TranscriptLine;
  prevDirection: "in" | "out" | null;
}) {
  const settings = useAppStore((s) => s.settings);
  const { t } = useTranslation();
  const isOut = line.direction === "out";

  // Direction routing label: «ВЫ → EN» / «СОБЕСЕДНИК → RU»
  const targetLang = isOut ? settings?.peerLang : settings?.myLang;
  const who = isOut ? t("live.sessionOutLabel") : t("live.sessionInLabel");
  const routeTarget = targetLang ? langLabel(targetLang) : "—";

  const accent = isOut ? "var(--color-cobalt)" : "var(--color-tangerine)";
  // Barely-there wash (~40% lighter than the *-tint tokens).
  const bg = isOut ? "rgb(30 91 215 / 0.045)" : "rgb(226 98 14 / 0.05)";
  const labelColor = isOut ? "text-cobalt-deep" : "text-tangerine-deep";

  const primary = line.translated || line.original;
  const hasSub = !!(line.translated && line.original);
  const isTyping = !line.closed;

  // 14px radius, with the corner nearest the speaker squared to 4px.
  const radius = isOut
    ? "14px 14px 4px 14px" // out → right side, bottom-right squared
    : "14px 14px 14px 4px"; // in → left side, bottom-left squared

  // Vertical rhythm: 10px within a direction, 18px across a direction change.
  const gapTop =
    prevDirection == null ? 0 : prevDirection === line.direction ? 10 : 18;

  return (
    <div
      className={`flex flex-col ${isOut ? "items-end" : "items-start"}`}
      style={{ marginTop: gapTop }}
    >
      <div
        className="lt-bubble-in max-w-[72%] pl-3.5 pr-4 py-2.5"
        style={{ background: bg, borderRadius: radius }}
      >
        <span
          className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.1em] mb-1.5 font-mono ${labelColor}`}
        >
          <span
            className="inline-block w-[3px] h-[10px] rounded-full"
            style={{ background: accent }}
          />
          {who} → {routeTarget}
        </span>
        <p className="text-[15px] leading-[22px] font-medium text-ink">
          {primary}
          {isTyping && (
            <span
              className="lt-typing align-middle ml-1.5"
              style={{ color: accent }}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </span>
          )}
        </p>
        {hasSub && (
          <p className="text-[12.5px] leading-[18px] text-muted mt-1">
            {line.original}
          </p>
        )}
      </div>
    </div>
  );
}
