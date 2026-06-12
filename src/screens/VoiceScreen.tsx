import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppStore } from "../stores/app";
import { VoiceCard } from "../components/VoiceCard";
import { Banner } from "../components/Banner";
import { IconMic, IconStopSquare, IconDownload } from "../components/Icons";
import { ipc } from "../lib/ipc";
import { filterAudioPaths, formatRecordingTime } from "../lib/voice";

const MAX_RECORD_SECS = 300; // 5 minutes

export function VoiceScreen() {
  const { t } = useTranslation();

  const voiceMessages = useAppStore((s) => s.voiceMessages);
  const loadVoice = useAppStore((s) => s.loadVoice);
  const upsertVoice = useAppStore((s) => s.upsertVoice);
  const setLastError = useAppStore((s) => s.setLastError);

  // Drop-zone state
  const [isDragOver, setIsDragOver] = useState(false);
  // Recording state. Seconds live in BOTH a ref (read synchronously by the
  // interval / stop handler, no stale closure) and state (drives the display).
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const recordingSecsRef = useRef(0);
  const isRecordingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Local notice (e.g. the 5:00 auto-stop) so a silent truncation never happens.
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);

  function setRecordingSecsBoth(v: number) {
    recordingSecsRef.current = v;
    setRecordingSecs(v);
  }

  // Load messages on mount
  useEffect(() => {
    void loadVoice();
  }, [loadVoice]);

  // Subscribe to drop events ONCE on mount. The handler reads `peerLang` via
  // the store at call time (no stale closure), so there's no re-registration
  // gap when the language changes mid-session.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let disposed = false;

    async function setupDrop() {
      const webview = getCurrentWebview();
      const un = await webview.onDragDropEvent(async (event) => {
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
            const targetLang =
              useAppStore.getState().settings?.peerLang ?? "en";
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
      // Guard against a StrictMode double-mount unmounting before the await
      // resolved — dispose immediately if so.
      if (disposed) un();
      else unlistenFn = un;
    }

    void setupDrop();

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
    // Mount-only: the handler reads dynamic state from the store at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recording timer. The interval reads/writes seconds via the ref and, on
  // reaching the cap, calls handleStopRecording DIRECTLY (not inside a setState
  // updater) so the auto-stop runs exactly once.
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        const next = recordingSecsRef.current + 1;
        if (next >= MAX_RECORD_SECS) {
          setRecordingSecsBoth(MAX_RECORD_SECS);
          setRecordingNotice(t("voice.recordCapReached"));
          void handleStopRecording();
        } else {
          setRecordingSecsBoth(next);
        }
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecordingSecsBoth(0);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  function startRecordingState() {
    isRecordingRef.current = true;
    setIsRecording(true);
  }
  function stopRecordingState() {
    isRecordingRef.current = false;
    setIsRecording(false);
  }

  async function handleStartRecording() {
    const micId = useAppStore.getState().settings?.micId ?? null;
    setRecordingNotice(null);
    try {
      await ipc.voiceRecordStart(micId);
      startRecordingState();
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
    // Read the live flag via the ref so the interval-driven auto-stop isn't
    // blocked by a stale closure value.
    if (!isRecordingRef.current) return;
    stopRecordingState();
    // Read languages/voice via the store (no stale closure) at stop time.
    const cur = useAppStore.getState().settings;
    const myLang = cur?.myLang ?? "ru";
    const peerLang = cur?.peerLang ?? "en";
    const ttsVoice = cur?.ttsVoice ?? "Kore";
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

        {/* Auto-stop / cap notice — truncation is never silent. */}
        {recordingNotice && (
          <div className="shrink-0">
            <Banner
              tone="warn"
              description={recordingNotice}
              onDismiss={() => setRecordingNotice(null)}
            />
          </div>
        )}

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
