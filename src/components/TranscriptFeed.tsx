import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app";
import { langLabel } from "../lib/languages";
import { IconSwap } from "./Icons";
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
        className="absolute inset-0 overflow-y-auto flex flex-col px-6 py-5"
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
            className="lt-press lt-card px-3.5 h-8 rounded-pill bg-surface border border-hairline text-caption text-ink hover:border-hairline-strong"
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
    <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center select-none px-6">
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center w-16 h-16 rounded-bubble bg-surface-2 text-muted"
      >
        <IconSwap size={28} />
      </span>
      <p className="text-lead text-ink-2 max-w-sm leading-relaxed text-balance">
        {t("live.transcriptEmpty")}
      </p>
      <div className="flex items-center gap-3 text-caption text-muted">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-surface-2 border border-hairline font-mono text-label text-ink-2 tabular-nums">
                {i + 1}
              </span>
              <span>{step}</span>
            </span>
            {i < steps.length - 1 && (
              <span aria-hidden="true" className="w-4 h-px bg-hairline-strong" />
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

  // Quiet, sentence-case caption: "You · EN" / "Peer · RU". Direction is read
  // from alignment + bubble fill + an 8px dot — not a colored side-stripe.
  const targetLang = isOut ? settings?.peerLang : settings?.myLang;
  const who = isOut ? t("live.sessionOutLabel") : t("live.sessionInLabel");
  const routeTarget = targetLang ? langLabel(targetLang) : null;

  // You → cobalt-tint (the single accent); Peer → neutral slate fill.
  const bubbleBg = isOut ? "bg-cobalt-tint" : "bg-surface-2";
  const dotColor = isOut ? "bg-cobalt" : "bg-tangerine";
  const typingColor = isOut ? "text-cobalt" : "text-muted";

  const primary = line.translated || line.original;
  const hasSub = !!(line.translated && line.original);
  const isTyping = !line.closed;

  // Soft bubble radius, with the corner nearest the speaker squared.
  const radius = isOut
    ? "16px 16px 4px 16px" // out → right side, bottom-right squared
    : "16px 16px 16px 4px"; // in → left side, bottom-left squared

  // Vertical rhythm: 12px within a direction, 22px across a direction change.
  const gapTop =
    prevDirection == null ? 0 : prevDirection === line.direction ? 12 : 22;

  return (
    <div
      className={`flex flex-col ${isOut ? "items-end" : "items-start"}`}
      style={{ marginTop: gapTop }}
    >
      <span
        className={`flex items-center gap-1.5 text-label text-muted mb-1.5 px-1 ${
          isOut ? "flex-row-reverse" : ""
        }`}
      >
        <span
          aria-hidden="true"
          className={`inline-block w-2 h-2 rounded-full ${dotColor}`}
        />
        {who}
        {routeTarget && (
          <span className="text-muted">· {routeTarget}</span>
        )}
      </span>
      <div
        className={`lt-bubble-in max-w-[72%] px-4 py-3 ${bubbleBg}`}
        style={{ borderRadius: radius }}
      >
        <p className="text-lead leading-relaxed text-ink">
          {primary}
          {isTyping && (
            <span
              className={`lt-typing align-middle ml-1.5 ${typingColor}`}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </span>
          )}
        </p>
        {hasSub && (
          <p className="text-caption leading-snug text-ink-2 mt-1.5">
            {line.original}
          </p>
        )}
      </div>
    </div>
  );
}
