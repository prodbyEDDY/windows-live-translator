import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc, type VoiceRecord } from "../lib/ipc";
import { useAppStore } from "../stores/app";
import { IconGrip, IconDownload } from "./Icons";
import { localeFor } from "../lib/format";

/** Refresh / retry arrow — inline SVG. */
function IconRetry({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

// Bundled drag thumbnail — resolved once and cached at module scope.
let dragIconPromise: Promise<string | null> | null = null;
function getDragIconPath(): Promise<string | null> {
  if (!dragIconPromise) {
    dragIconPromise = resolveResource("icons/drag-audio.png").catch(() => null);
  }
  return dragIconPromise;
}

/** Copy glyph — inline SVG (replaces the ⎘ unicode glyph). */
function IconCopy({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15.5A1.5 1.5 0 0 1 3.5 14V5A1.5 1.5 0 0 1 5 3.5h9A1.5 1.5 0 0 1 15.5 5" />
    </svg>
  );
}

/** Filled play triangle — inline SVG (replaces the ▶ unicode glyph). */
function IconPlay({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
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
  const { t, i18n } = useTranslation();
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

  // Direction is read from a quiet neutral chip + the kind label, never a hue.
  // The accent only tints the functional progress track (cobalt for «Вы»/out,
  // slate for the peer/in role — both neutral, no second hue introduced).
  const isIn = record.kind === "in";
  const accent = isIn ? "var(--color-tangerine)" : "var(--color-cobalt)";
  const kindLabel = isIn ? t("voice.kindIn") : t("voice.kindOut");

  const createdAt = new Date(record.createdAt).toLocaleTimeString(
    localeFor(i18n.language),
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }
  );

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
  // Localize known pipeline error short-codes (incl. the ElevenLabs ones); fall
  // back to the raw short for anything not in the map.
  const errLabel = errMsg
    ? i18n.exists(`voice.stageError.${errMsg}`)
      ? t(`voice.stageError.${errMsg}`)
      : errMsg
    : null;
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
    // Re-run with the CURRENT voice language for this card's direction, so changing
    // the voice language pair then hitting retry re-translates into the new language:
    // incoming (dropped) → my voice language; outgoing (recorded) → the peer's voice
    // language. (The TTS voice for outgoing cards is taken fresh from settings by the
    // backend on retry.)
    const settings = useAppStore.getState().settings;
    const targetLang =
      record.kind === "in"
        ? settings?.voiceMyLang ?? "ru"
        : settings?.voicePeerLang ?? "en";
    try {
      await ipc.voiceRetry(record.id, targetLang);
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
    <div className="bg-surface border border-hairline rounded-card lt-card lt-card-hover p-5 flex flex-col gap-5">
      {/* ---- Header: direction chip + time, status on the right ---- */}
      <div className="flex items-center gap-2.5">
        <span className="inline-flex items-center h-6 px-2.5 rounded-pill bg-surface-2 text-caption font-medium text-ink-2">
          {kindLabel}
        </span>
        <span className="font-mono text-code text-muted tabular-nums">{createdAt}</span>
        <div className="ml-auto flex items-center gap-3">
          {/* Inline progress line: label + thin 3-step track */}
          {errMsg ? (
            <Tooltip>
              <TooltipTrigger>
                <span
                  className={`inline-flex items-center gap-1.5 text-label font-medium ${stageColor} ${isProcessing ? "lt-pulse-dot" : ""}`}
                >
                  {stageName}
                </span>
              </TooltipTrigger>
              <TooltipContent>{errLabel}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span
                className={`text-label font-medium ${stageColor} ${isProcessing ? "lt-pulse-dot" : ""}`}
              >
                {stageName}
              </span>
              <StageTrack steps={stepIndex} accent={accent} done={isDone} />
            </span>
          )}
          {/* Retry is available once a card is no longer processing (done OR
              error): re-runs the translation with the currently-selected
              language for this card's direction. */}
          {!isProcessing && (
            <button
              onClick={() => void handleRetry()}
              aria-label={t("voice.retry")}
              title={t("voice.retry")}
              className="lt-press inline-flex items-center justify-center w-7 h-7 rounded-pill text-muted border border-hairline hover:text-ink hover:border-hairline-strong"
            >
              <IconRetry size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ---- Original transcript ---- */}
      {record.transcript && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-label font-medium text-muted">
              {t("voice.originalLabel")}
              {record.sourceLang ? ` · ${record.sourceLang.toUpperCase()}` : ""}
            </span>
            <CopyButton
              copied={copiedOriginal}
              onClick={() => void handleCopy(record.transcript!, "original")}
              ariaLabel={t("voice.copyOriginal")}
              copiedLabel={t("voice.copied")}
            />
          </div>
          <p className="text-body text-ink-2 leading-relaxed">{record.transcript}</p>
        </div>
      )}

      {/* ---- Translation ---- */}
      {record.translation && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-label font-medium text-ink-2">
              {t("voice.translationLabel")}
            </span>
            <CopyButton
              copied={copiedTranslation}
              onClick={() => void handleCopy(record.translation!, "translation")}
              ariaLabel={t("voice.copyTranslation")}
              copiedLabel={t("voice.copied")}
            />
          </div>
          <p className="text-lead text-ink leading-relaxed font-medium">
            {record.translation}
          </p>
        </div>
      )}

      {/* ---- Audio players (lazy: mount real <audio> only on first play) ---- */}
      {(sourceUrl || translatedUrl) && (
        <div className="flex flex-col gap-2.5">
          {sourceUrl && (
            <LazyAudio
              src={sourceUrl}
              label={t("voice.originalLabel")}
              playLabel={t("voice.play")}
            />
          )}
          {translatedUrl && (
            <LazyAudio
              src={translatedUrl}
              label={t("voice.translationLabel")}
              playLabel={t("voice.play")}
              primary
            />
          )}
        </div>
      )}

      {/* ---- Out + done: drag handle (primary affordance) + save ---- */}
      {record.kind === "out" && isDone && record.translatedAudioPath && (
        <div className="flex flex-col gap-2 pt-4 border-t border-hairline">
          <div className="flex items-center gap-2 flex-wrap">
            <div
              role="button"
              tabIndex={0}
              aria-label={t("voice.dragHandle").replace("⠿ ", "")}
              className="lt-card lt-card-hover group flex items-center gap-2 pl-3 pr-4 h-10 rounded-pill border border-dashed border-cobalt/45 bg-cobalt-tint text-caption font-medium text-cobalt-deep cursor-grab active:cursor-grabbing select-none focus-visible:outline-2 focus-visible:outline-cobalt focus-visible:outline-offset-2"
              onMouseDown={() => void handleDragOut()}
              onDragStart={(e) => {
                e.preventDefault();
                void handleDragOut();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void handleDragOut();
                }
              }}
              title={t("voice.dragHandle")}
            >
              <IconGrip size={16} className="text-cobalt" aria-hidden="true" />
              <span>{t("voice.dragHandle").replace("⠿ ", "")}</span>
            </div>
            <button
              onClick={() => void handleSaveAs()}
              className="lt-press inline-flex items-center gap-1.5 px-3.5 h-10 rounded-pill border border-hairline text-caption text-ink hover:border-hairline-strong"
            >
              <IconDownload size={15} />
              {t("voice.saveAs")}
            </button>
          </div>
          <p className="text-label text-muted">{t("voice.dragDisclaimer")}</p>
        </div>
      )}
    </div>
  );
}

/** Quiet copy button: icon by default, swaps to a "Copied" confirmation. */
function CopyButton({
  copied,
  onClick,
  ariaLabel,
  copiedLabel,
}: {
  copied: boolean;
  onClick: () => void;
  ariaLabel: string;
  copiedLabel: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      className="lt-press ml-auto inline-flex items-center gap-1 h-6 px-1.5 rounded-input text-label text-muted hover:text-cobalt hover:bg-cobalt-tint"
    >
      {copied ? (
        <span className="text-ok font-medium">{copiedLabel}</span>
      ) : (
        <IconCopy size={14} />
      )}
    </button>
  );
}

/**
 * Lazy audio gate. Shows a clear play control (filled triangle + label) and only
 * mounts the real <audio> element after the first click — so a long history list
 * doesn't eagerly create dozens of media elements (and fetch their metadata) up
 * front. Layout stays stable: the control occupies the same 40px-tall row the
 * player will. `primary` marks the translated-audio control (cobalt) so the
 * useful output reads as the obvious action.
 */
function LazyAudio({
  src,
  label,
  playLabel,
  primary = false,
}: {
  src: string;
  label: string;
  playLabel: string;
  primary?: boolean;
}) {
  const [mounted, setMounted] = useState(false);

  if (mounted) {
    return <audio controls autoPlay preload="none" src={src} className="w-full h-10" />;
  }

  return (
    <button
      type="button"
      onClick={() => setMounted(true)}
      aria-label={`${playLabel}: ${label}`}
      className={`lt-press group flex w-full items-center gap-3 h-10 px-3 rounded-input border text-caption font-medium ${
        primary
          ? "border-cobalt/30 bg-cobalt-tint text-cobalt-deep hover:border-cobalt/50"
          : "border-hairline bg-surface text-ink-2 hover:border-hairline-strong"
      }`}
    >
      <span
        className={`inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${
          primary ? "bg-cobalt text-white" : "bg-surface-2 text-ink-2"
        }`}
      >
        <IconPlay size={12} />
      </span>
      <span>{label}</span>
      <span className="ml-auto text-label text-muted group-hover:text-current">
        {playLabel}
      </span>
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
