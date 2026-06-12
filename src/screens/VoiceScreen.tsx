import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppStore } from "../stores/app";
import { VoiceCard } from "../components/VoiceCard";
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
            // Auto-stop at cap
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
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* ---- Drop overlay ---- */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/20 border-4 border-dashed border-blue-400 rounded-lg pointer-events-none">
          <div className="bg-white rounded-xl px-8 py-6 shadow-xl text-center">
            <p className="text-2xl mb-2">🎵</p>
            <p className="text-lg font-semibold text-blue-700">{t("voice.dropOverlay")}</p>
          </div>
        </div>
      )}

      {/* ---- Header ---- */}
      <div className="flex flex-col gap-3 p-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-800">{t("voice.title")}</h1>

          {/* Record / Stop button */}
          <div className="flex items-center gap-3">
            {isRecording && (
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-sm font-mono tabular-nums text-gray-700">
                  {formatRecordingTime(recordingSecs)}
                </span>
                <span className="text-xs text-gray-400">{t("voice.recordCap")}</span>
              </div>
            )}
            {isRecording ? (
              <Button
                variant="danger"
                onPress={() => void handleStopRecording()}
              >
                ⏹ {t("voice.stopButton")}
              </Button>
            ) : (
              <Button
                variant="primary"
                onPress={() => void handleStartRecording()}
              >
                ⏺ {t("voice.recordButton")}
              </Button>
            )}
          </div>
        </div>

        {/* Drop hint when not dragging */}
        {!isDragOver && (
          <p className="text-xs text-gray-400 text-center border border-dashed border-gray-200 rounded py-2">
            {t("voice.dropHint")}
          </p>
        )}
      </div>

      {/* ---- Card list ---- */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {voiceMessages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-gray-400 text-sm whitespace-pre-line text-center max-w-xs leading-relaxed">
              {t("voice.emptyHint")}
            </p>
          </div>
        ) : (
          voiceMessages.map((msg) => (
            <VoiceCard key={msg.id} record={msg} />
          ))
        )}
      </div>
    </div>
  );
}
