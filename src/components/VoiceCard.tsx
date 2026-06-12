import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Chip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc, type VoiceRecord } from "../lib/ipc";

interface VoiceCardProps {
  record: VoiceRecord;
}

type StageColor = "default" | "success" | "danger" | "warning";

function stageColor(stage: string): StageColor {
  if (stage === "done") return "success";
  if (stage.startsWith("error")) return "danger";
  if (stage === "pending" || stage === "transcribing" || stage === "synthesizing")
    return "default";
  return "default";
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

  const kindIcon = record.kind === "in" ? "📥" : "📤";
  const kindLabel =
    record.kind === "in" ? t("voice.kindIn") : t("voice.kindOut");

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
      // clipboard access failed silently
    }
  }

  async function handleRetry() {
    try {
      await ipc.voiceRetry(record.id);
    } catch {
      // error surfaces via voice:progress event
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
        // error surfaces via store lastError
      }
    }
  }

  async function handleDragOut() {
    if (!record.translatedAudioPath) return;
    try {
      // icon is required by the API — we pass the audio file path itself as icon.
      // On Windows this shows no visual preview but drag proceeds correctly.
      await startDrag({
        item: [record.translatedAudioPath],
        icon: record.translatedAudioPath,
      });
    } catch {
      // drag cancelled — silent
    }
  }

  const sourceUrl =
    record.sourcePath ? convertFileSrc(record.sourcePath) : null;
  const translatedUrl =
    record.translatedAudioPath
      ? convertFileSrc(record.translatedAudioPath)
      : null;

  return (
    <Card className="p-4 flex flex-col gap-3">
      {/* ---- Header ---- */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-base">{kindIcon}</span>
        <span className="text-sm font-medium text-gray-700">{kindLabel}</span>
        <span className="text-xs text-gray-400">{createdAt}</span>
        <div className="ml-auto flex items-center gap-1">
          {errMsg ? (
            <Tooltip>
              <TooltipTrigger>
                <Chip
                  color={stageColor(record.stage)}
                  size="sm"
                  className={isProcessing ? "animate-pulse" : undefined}
                >
                  {stageName}
                </Chip>
              </TooltipTrigger>
              <TooltipContent>{errMsg}</TooltipContent>
            </Tooltip>
          ) : (
            <Chip
              color={stageColor(record.stage)}
              size="sm"
              className={isProcessing ? "animate-pulse" : undefined}
            >
              {stageName}
            </Chip>
          )}
          {errMsg && (
            <Button
              size="sm"
              variant="outline"
              onPress={() => void handleRetry()}
            >
              {t("voice.retry")}
            </Button>
          )}
        </div>
      </div>

      {/* ---- Transcript / Translation ---- */}
      {record.transcript && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">
              {t("voice.originalLabel")}
              {record.sourceLang ? ` [${record.sourceLang}]` : ""}
            </span>
            <button
              onClick={() => void handleCopy(record.transcript!, "original")}
              className="text-xs text-blue-500 hover:underline ml-auto"
              aria-label={t("voice.copyOriginal")}
            >
              {copiedOriginal ? t("voice.copied") : "⎘"}
            </button>
          </div>
          <p className="text-sm text-gray-500 leading-relaxed">{record.transcript}</p>
        </div>
      )}

      {record.translation && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-700 font-medium">
              {t("voice.translationLabel")}
            </span>
            <button
              onClick={() => void handleCopy(record.translation!, "translation")}
              className="text-xs text-blue-500 hover:underline ml-auto"
              aria-label={t("voice.copyTranslation")}
            >
              {copiedTranslation ? t("voice.copied") : "⎘"}
            </button>
          </div>
          <p className="text-sm text-gray-900 leading-relaxed font-medium">
            {record.translation}
          </p>
        </div>
      )}

      {/* ---- Audio players ---- */}
      {sourceUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">
            {record.kind === "in" ? t("voice.kindIn") : t("voice.kindOut")}
          </span>
          <audio controls src={sourceUrl} className="w-full h-8" />
        </div>
      )}

      {translatedUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">{t("voice.translationLabel")}</span>
          <audio controls src={translatedUrl} className="w-full h-8" />
        </div>
      )}

      {/* ---- Out + done: drag handle + save ---- */}
      {record.kind === "out" && isDone && record.translatedAudioPath && (
        <div className="flex flex-col gap-1 pt-1 border-t border-gray-100">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Drag handle */}
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-dashed border-gray-300 text-sm text-gray-600 cursor-grab hover:border-blue-400 hover:text-blue-600 select-none"
              onMouseDown={() => void handleDragOut()}
              onDragStart={(e) => {
                e.preventDefault();
                void handleDragOut();
              }}
              title={t("voice.dragHandle")}
            >
              <span className="text-base leading-none">⠿</span>
              <span>{t("voice.dragHandle").replace("⠿ ", "")}</span>
            </div>

            {/* Save As */}
            <Button
              size="sm"
              variant="outline"
              onPress={() => void handleSaveAs()}
            >
              {t("voice.saveAs")}
            </Button>
          </div>
          <p className="text-xs text-gray-400 italic">{t("voice.dragDisclaimer")}</p>
        </div>
      )}
    </Card>
  );
}
