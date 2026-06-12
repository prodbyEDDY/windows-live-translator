import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
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
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm select-none">
        {t("live.transcriptEmpty")}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto flex flex-col gap-3 p-4"
      >
        {lines.map((line) => (
          <TranscriptBubble key={line.id} line={line} />
        ))}
      </div>

      {/* Scroll-to-bottom button */}
      {!pinned && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
          <Button
            size="sm"
            variant="outline"
            className="shadow-md bg-white/90 text-gray-700"
            onPress={scrollToBottom}
          >
            {t("live.scrollDown")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TranscriptBubble({ line }: { line: TranscriptLine }) {
  const isOut = line.direction === "out";

  return (
    <div className={`flex flex-col gap-0.5 ${isOut ? "items-end" : "items-start"}`}>
      <div
        className={`
          max-w-[80%] rounded-2xl px-4 py-2.5
          ${isOut
            ? "bg-blue-500 text-white rounded-br-sm"
            : "bg-gray-100 text-gray-900 rounded-bl-sm"
          }
        `}
      >
        {/* Primary display: translated if available, otherwise original */}
        <p className="text-sm leading-relaxed">
          {line.translated || line.original}
        </p>

        {/* Original shown smaller/muted below translated */}
        {line.translated && line.original && (
          <p
            className={`text-xs mt-1 leading-relaxed ${
              isOut ? "text-blue-200" : "text-gray-400"
            }`}
          >
            {line.original}
          </p>
        )}
      </div>
    </div>
  );
}
