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

  // Stage pill tone
  const stagePill = errMsg
    ? "bg-danger/10 text-danger"
    : isDone
      ? "bg-ok/10 text-ok"
      : "bg-stone-100 text-muted";

  return (
    <div
      className="relative bg-surface border border-hairline rounded-card shadow-studio p-4 pl-5 flex flex-col gap-3 overflow-hidden"
    >
      <span
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: accent }}
      />

      {/* ---- Header ---- */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="text-[13px] font-semibold"
          style={{ color: accent }}
        >
          {kindLabel}
        </span>
        <span className="font-mono text-[11px] text-muted">{createdAt}</span>
        <div className="ml-auto flex items-center gap-2">
          {errMsg ? (
            <Tooltip>
              <TooltipTrigger>
                <span
                  className={`inline-flex items-center h-6 px-2.5 rounded-pill text-[11px] font-medium ${stagePill} ${isProcessing ? "lt-pulse-dot" : ""}`}
                >
                  {stageName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{errMsg}</TooltipContent>
            </Tooltip>
          ) : (
            <span
              className={`inline-flex items-center h-6 px-2.5 rounded-pill text-[11px] font-medium ${stagePill} ${isProcessing ? "lt-pulse-dot" : ""}`}
            >
              {stageName}
            </span>
          )}
          {errMsg && (
            <button
              onClick={() => void handleRetry()}
              className="px-3 h-6 rounded-pill text-[11px] font-medium border border-hairline text-ink hover:border-stone-300 transition-colors"
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

      {/* ---- Audio players ---- */}
      {sourceUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{kindLabel}</span>
          <audio controls src={sourceUrl} className="w-full max-w-md h-9" />
        </div>
      )}
      {translatedUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{t("voice.translationLabel")}</span>
          <audio controls src={translatedUrl} className="w-full max-w-md h-9" />
        </div>
      )}

      {/* ---- Out + done: drag handle + save ---- */}
      {record.kind === "out" && isDone && record.translatedAudioPath && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-hairline">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-pill border border-dashed border-stone-300 text-[12px] text-muted cursor-grab hover:text-cobalt hover:border-cobalt/50 hover:-translate-y-px hover:shadow-studio transition-all select-none"
              onMouseDown={() => void handleDragOut()}
              onDragStart={(e) => {
                e.preventDefault();
                void handleDragOut();
              }}
              title={t("voice.dragHandle")}
            >
              <IconGrip size={15} />
              <span>{t("voice.dragHandle").replace("⠿ ", "")}</span>
            </div>
            <button
              onClick={() => void handleSaveAs()}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-pill border border-hairline text-[12px] text-ink hover:border-stone-300 transition-colors"
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
