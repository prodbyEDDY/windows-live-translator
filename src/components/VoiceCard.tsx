import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc, type VoiceRecord } from "../lib/ipc";
import { IconGrip, IconDownload } from "./Icons";

// Bundled drag thumbnail — resolved once and cached at module scope.
let dragIconPromise: Promise<string | null> | null = null;
function getDragIconPath(): Promise<string | null> {
  if (!dragIconPromise) {
    dragIconPromise = resolveResource("icons/drag-audio.png").catch(() => null);
  }
  return dragIconPromise;
}

interface VoiceCardProps {
  record: VoiceRecord;
}

function stageIsProcessing(stage: string): boolean {
  return stage === "transcribing" || stage === "synthesizing" || stage === "pending";
}

function errorMessage(stage: string): string | null {
  if (stage.startsWith("error:")) return stage.slice(6);
  if (stage === "error") return "unknown error";
  return null;
}

export function VoiceCard({ record }: VoiceCardProps) {
  const { t } = useTranslation();
  const [copiedOriginal, setCopiedOriginal] = useState(false);
  const [copiedTranslation, setCopiedTranslation] = useState(false);
  const dragIconRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void getDragIconPath().then((p) => {
      if (active) dragIconRef.current = p;
    });
    return () => {
      active = false;
    };
  }, []);

  // «Собеседник» (in) = tangerine, «Вы» (out) = cobalt.
  const isIn = record.kind === "in";
  const accent = isIn ? "var(--color-tangerine)" : "var(--color-cobalt)";
  const kindLabel = isIn ? t("voice.kindIn") : t("voice.kindOut");

  const createdAt = new Date(record.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const stageName = (() => {
    if (record.stage.startsWith("error")) return t("voice.stageLabel.error");
    const key = record.stage as keyof typeof stageLabels;
    const stageLabels = {
      pending: t("voice.stageLabel.pending"),
      transcribing: t("voice.stageLabel.transcribing"),
      synthesizing: t("voice.stageLabel.synthesizing"),
      done: t("voice.stageLabel.done"),
    };
    return stageLabels[key] ?? record.stage;
  })();

  const errMsg = errorMessage(record.stage);
  const isProcessing = stageIsProcessing(record.stage);
  const isDone = record.stage === "done";

  // Pipeline progress: 0..3 steps complete (record → transcribe → synthesize).
  const stepIndex = (() => {
    if (errMsg) return 0;
    if (isDone) return 3;
    if (record.stage === "synthesizing") return 2;
    if (record.stage === "transcribing") return 1;
    return 0; // pending
  })();

  async function handleCopy(text: string, which: "original" | "translation") {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "original") {
        setCopiedOriginal(true);
        setTimeout(() => setCopiedOriginal(false), 1500);
      } else {
        setCopiedTranslation(true);
        setTimeout(() => setCopiedTranslation(false), 1500);
      }
    } catch {
      /* clipboard access failed silently */
    }
  }

  async function handleRetry() {
    try {
      await ipc.voiceRetry(record.id);
    } catch {
      /* error surfaces via voice:progress event */
    }
  }

  async function handleSaveAs() {
    if (!record.translatedAudioPath) return;
    const fileName = record.translatedAudioPath.split(/[\\/]/).pop() ?? "voice.ogg";
    const dest = await save({
      defaultPath: fileName,
      filters: [{ name: "Audio", extensions: ["ogg"] }],
    });
    if (dest) {
      try {
        await ipc.voiceExport(record.id, dest);
      } catch {
        /* error surfaces via store lastError */
      }
    }
  }

  async function handleDragOut() {
    if (!record.translatedAudioPath) return;
    try {
      const icon = dragIconRef.current ?? record.translatedAudioPath;
      await startDrag({ item: [record.translatedAudioPath], icon });
    } catch {
      /* drag cancelled — silent */
    }
  }

  const sourceUrl = record.sourcePath ? convertFileSrc(record.sourcePath) : null;
  const translatedUrl = record.translatedAudioPath
    ? convertFileSrc(record.translatedAudioPath)
    : null;

  // Stage label tone
  const stageColor = errMsg
    ? "text-danger"
    : isDone
      ? "text-ok"
      : "text-muted";

  return (
    <div
      className="relative bg-surface border border-hairline rounded-card lt-card lt-card-hover p-4 pl-5 flex flex-col gap-3 overflow-hidden"
    >
      <span
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: accent }}
      />

      {/* ---- Header ---- */}
      <div className="flex items-center gap-2.5">
        <span
          className="text-[13px] font-semibold"
          style={{ color: accent }}
        >
          {kindLabel}
        </span>
        <span className="font-mono text-[11px] text-muted">{createdAt}</span>
        <div className="ml-auto flex items-center gap-3">
          {/* Inline progress line: label + thin 3-step track */}
          {errMsg ? (
            <Tooltip>
              <TooltipTrigger>
                <span
                  className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${stageColor} ${isProcessing ? "lt-pulse-dot" : ""}`}
                >
                  {stageName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{errMsg}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span
                className={`text-[11px] font-medium ${stageColor} ${isProcessing ? "lt-pulse-dot" : ""}`}
              >
                {stageName}
              </span>
              <StageTrack steps={stepIndex} accent={accent} done={isDone} />
            </span>
          )}
          {errMsg && (
            <button
              onClick={() => void handleRetry()}
              className="lt-press px-3 h-6 rounded-pill text-[11px] font-medium border border-hairline text-ink hover:border-stone-300"
            >
              {t("voice.retry")}
            </button>
          )}
        </div>
      </div>

      {/* ---- Transcript ---- */}
      {record.transcript && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              {t("voice.originalLabel")}
              {record.sourceLang ? ` · ${record.sourceLang.toUpperCase()}` : ""}
            </span>
            <button
              onClick={() => void handleCopy(record.transcript!, "original")}
              className="text-[11px] text-cobalt hover:underline ml-auto"
              aria-label={t("voice.copyOriginal")}
            >
              {copiedOriginal ? t("voice.copied") : "⎘"}
            </button>
          </div>
          <p className="text-[13px] text-muted leading-relaxed">{record.transcript}</p>
        </div>
      )}

      {/* ---- Translation ---- */}
      {record.translation && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink">
              {t("voice.translationLabel")}
            </span>
            <button
              onClick={() => void handleCopy(record.translation!, "translation")}
              className="text-[11px] text-cobalt hover:underline ml-auto"
              aria-label={t("voice.copyTranslation")}
            >
              {copiedTranslation ? t("voice.copied") : "⎘"}
            </button>
          </div>
          <p className="text-[14px] text-ink leading-relaxed font-medium">
            {record.translation}
          </p>
        </div>
      )}

      {/* ---- Audio players (lazy: mount real <audio> only on first play) ---- */}
      {sourceUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{kindLabel}</span>
          <LazyAudio src={sourceUrl} label={kindLabel} playLabel={t("voice.play")} />
        </div>
      )}
      {translatedUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{t("voice.translationLabel")}</span>
          <LazyAudio
            src={translatedUrl}
            label={t("voice.translationLabel")}
            playLabel={t("voice.play")}
          />
        </div>
      )}

      {/* ---- Out + done: drag handle (primary affordance) + save ---- */}
      {record.kind === "out" && isDone && record.translatedAudioPath && (
        <div className="flex flex-col gap-1.5 pt-3 border-t border-hairline">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="lt-card lt-card-hover group flex items-center gap-2 pl-2.5 pr-3.5 h-9 rounded-pill border border-dashed border-cobalt/40 bg-cobalt-tint/50 text-[12px] font-medium text-cobalt-deep cursor-grab active:cursor-grabbing select-none"
              onMouseDown={() => void handleDragOut()}
              onDragStart={(e) => {
                e.preventDefault();
                void handleDragOut();
              }}
              title={t("voice.dragHandle")}
            >
              <IconGrip size={15} className="text-cobalt" />
              <span>{t("voice.dragHandle").replace("⠿ ", "")}</span>
            </div>
            <button
              onClick={() => void handleSaveAs()}
              className="lt-press inline-flex items-center gap-1.5 px-3 h-9 rounded-pill border border-hairline text-[12px] text-ink hover:border-stone-300"
            >
              <IconDownload size={14} />
              {t("voice.saveAs")}
            </button>
          </div>
          <p className="text-[11px] text-muted italic">{t("voice.dragDisclaimer")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * Lazy audio gate. Shows a small play-pill (▶ + label) and only mounts the real
 * <audio> element after the first click — so a long history list doesn't eagerly
 * create dozens of media elements (and fetch their metadata) up front. Layout
 * stays stable: the pill occupies the same 36px-tall row the player will.
 */
function LazyAudio({
  src,
  label,
  playLabel,
}: {
  src: string;
  label: string;
  playLabel: string;
}) {
  const [mounted, setMounted] = useState(false);

  if (mounted) {
    return (
      <audio
        controls
        autoPlay
        preload="none"
        src={src}
        className="w-full max-w-md h-9"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setMounted(true)}
      aria-label={`${playLabel}: ${label}`}
      className="lt-press inline-flex items-center gap-2 self-start pl-2.5 pr-3.5 h-9 rounded-pill border border-hairline bg-surface text-[12px] text-ink hover:border-stone-300"
    >
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-cobalt-tint text-cobalt text-[10px] leading-none">
        ▶
      </span>
      <span>{playLabel}</span>
    </button>
  );
}

/** Thin 3-step pipeline track: record → transcribe → synthesize. */
function StageTrack({
  steps,
  accent,
  done,
}: {
  steps: number;
  accent: string;
  done: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
      {[0, 1, 2].map((i) => {
        const filled = i < steps;
        return (
          <span
            key={i}
            className="h-[3px] w-4 rounded-full transition-colors duration-200"
            style={{
              background: filled
                ? done
                  ? "var(--color-ok)"
                  : accent
                : "var(--color-hairline)",
            }}
          />
        );
      })}
    </span>
  );
}
