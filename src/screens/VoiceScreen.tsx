import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppStore } from "../stores/app";
import { VoiceCard } from "../components/VoiceCard";
import { IconMic, IconStopSquare, IconDownload } from "../components/Icons";
import { ipc } from "../lib/ipc";
import { filterAudioPaths, formatRecordingTime } from "../lib/voice";

const MAX_RECORD_SECS = 300; // 5 minutes

export function VoiceScreen() {
  const { t } = useTranslation();

  const settings = useAppStore((s) => s.settings);
  const voiceMessages = useAppStore((s) => s.voiceMessages);
  const loadVoice = useAppStore((s) => s.loadVoice);
  const upsertVoice = useAppStore((s) => s.upsertVoice);
  const setLastError = useAppStore((s) => s.setLastError);

  // Drop-zone state
  const [isDragOver, setIsDragOver] = useState(false);
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load messages on mount
  useEffect(() => {
    void loadVoice();
  }, [loadVoice]);

  // Subscribe to drop events
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;

    async function setupDrop() {
      const webview = getCurrentWebview();
      unlistenFn = await webview.onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          setIsDragOver(true);
        } else if (payload.type === "leave") {
          setIsDragOver(false);
        } else if (payload.type === "drop") {
          setIsDragOver(false);
          const paths: string[] = payload.paths ?? [];
          const { ok, rejected } = filterAudioPaths(paths);

          if (rejected.length > 0) {
            const names = rejected.map((p) => p.split(/[\\/]/).pop()).join(", ");
            setLastError(t("voice.error.notAudio", { files: names }));
          }

          for (const path of ok) {
            const targetLang = settings?.peerLang ?? "en";
            try {
              const id = await ipc.voiceImport(path, targetLang);
              const rec = await ipc.voiceGet(id);
              if (rec) upsertVoice(rec);
            } catch (e) {
              setLastError(String(e));
            }
          }
        }
      });
    }

    void setupDrop();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [settings?.peerLang, setLastError, t, upsertVoice]);

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setRecordingSecs((s) => {
          if (s + 1 >= MAX_RECORD_SECS) {
            void handleStopRecording();
            return MAX_RECORD_SECS;
          }
          return s + 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecordingSecs(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  async function handleStartRecording() {
    const micId = settings?.micId ?? null;
    try {
      await ipc.voiceRecordStart(micId);
      setIsRecording(true);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("already_recording")) {
        setLastError(t("voice.error.alreadyRecording"));
      } else {
        setLastError(msg);
      }
    }
  }

  async function handleStopRecording() {
    if (!isRecording) return;
    setIsRecording(false);
    const myLang = settings?.myLang ?? "ru";
    const peerLang = settings?.peerLang ?? "en";
    const ttsVoice = settings?.ttsVoice ?? "Kore";
    try {
      const id = await ipc.voiceRecordStop(myLang, peerLang, ttsVoice);
      const rec = await ipc.voiceGet(id);
      if (rec) upsertVoice(rec);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("too_short")) {
        setLastError(t("voice.error.tooShort"));
      } else {
        setLastError(msg);
      }
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* ---- Drop overlay ---- */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-paper/80 backdrop-blur-[2px] pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-card border-2 border-dashed border-cobalt bg-surface/90 px-12 py-9 shadow-studio">
            <span className="font-display text-[56px] leading-none text-cobalt">
              <IconDownload size={56} />
            </span>
            <p className="font-display text-[18px] font-semibold text-cobalt-deep">
              {t("voice.dropOverlay")}
            </p>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 w-full max-w-[920px] mx-auto px-6 py-6 flex flex-col gap-5">
        {/* ---- Header row ---- */}
        <div className="flex items-center justify-between gap-4 shrink-0">
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none">
            {t("voice.title")}
          </h1>

          <div className="flex items-center gap-3">
            {isRecording && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] text-ink tabular-nums">
                  {formatRecordingTime(recordingSecs)}
                </span>
                <span className="text-[11px] text-muted">{t("voice.recordCap")}</span>
              </div>
            )}
            {/* Record FAB */}
            <div className="relative">
              {isRecording && (
                <span className="absolute inset-0 rounded-full bg-tangerine/40 lt-ring" />
              )}
              <button
                onClick={() =>
                  isRecording
                    ? void handleStopRecording()
                    : void handleStartRecording()
                }
                aria-label={
                  isRecording ? t("voice.stopButton") : t("voice.recordButton")
                }
                className={`relative flex items-center justify-center w-14 h-14 rounded-full text-white shadow-studio transition-colors ${
                  isRecording
                    ? "bg-tangerine hover:bg-tangerine-deep"
                    : "bg-cobalt hover:bg-cobalt-deep"
                }`}
              >
                {isRecording ? <IconStopSquare size={22} /> : <IconMic size={22} />}
              </button>
            </div>
          </div>
        </div>

        {/* Drop hint */}
        <div className="flex items-center justify-center gap-2 rounded-card border border-dashed border-hairline py-2.5 text-[12px] text-muted shrink-0">
          <IconDownload size={14} />
          {t("voice.dropHint")}
        </div>

        {/* ---- Card list ---- */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 -mx-1 px-1">
          {voiceMessages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
              <span className="font-display text-[56px] leading-none text-stone-200">
                ◎
              </span>
              <p className="text-[13px] text-muted whitespace-pre-line max-w-sm leading-relaxed">
                {t("voice.emptyHint")}
              </p>
            </div>
          ) : (
            voiceMessages.map((msg) => <VoiceCard key={msg.id} record={msg} />)
          )}
        </div>
      </div>
    </div>
  );
}
