import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectIndicator,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@heroui/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppStore } from "../stores/app";
import { VoiceCard } from "../components/VoiceCard";
import { Banner } from "../components/Banner";
import { IconMic, IconStopSquare, IconDownload, IconMicMessage, IconSwap } from "../components/Icons";
import { DeviceSelect, buildDeviceOptions } from "./SettingsScreen";
import { ipc } from "../lib/ipc";
import { filterAudioPaths, formatRecordingTime } from "../lib/voice";
import { LANGUAGES, langLabel, langAutonym } from "../lib/languages";
import { isLoopbackCaptureDevice } from "../lib/echo";

const MAX_RECORD_SECS = 300; // 5 minutes

export function VoiceScreen() {
  const { t } = useTranslation();

  const voiceMessages = useAppStore((s) => s.voiceMessages);
  const loadVoice = useAppStore((s) => s.loadVoice);
  const upsertVoice = useAppStore((s) => s.upsertVoice);
  const setLastError = useAppStore((s) => s.setLastError);
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const devices = useAppStore((s) => s.devices);
  const refreshDevices = useAppStore((s) => s.refreshDevices);

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
            // A dropped file is an INCOMING message FROM the peer, so it must be
            // translated INTO the user's OWN voice language (voiceMyLang) — not the
            // peer's. (Recording, below, targets voicePeerLang for the outgoing clip.)
            const targetLang =
              useAppStore.getState().settings?.voiceMyLang ?? "ru";
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
    const micId = useAppStore.getState().settings?.voiceMicId ?? null;
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
    // Read languages/voice via the store (no stale closure) at stop time. Voice
    // messages use their OWN language pair, independent of the live pair.
    const cur = useAppStore.getState().settings;
    const myLang = cur?.voiceMyLang ?? "ru";
    const peerLang = cur?.voicePeerLang ?? "en";
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

  // Voice-message device + language controls (independent of the live mode).
  const voiceMicOptions = buildDeviceOptions(
    (devices?.inputs ?? []).filter((d) => !isLoopbackCaptureDevice(d.name))
  );
  const sysDefault = t("settings.audio.systemDefault");
  const voiceMyLang = settings?.voiceMyLang ?? "ru";
  const voicePeerLang = settings?.voicePeerLang ?? "en";

  function handleSwapVoiceLangs() {
    void patchSettings({ voiceMyLang: voicePeerLang, voicePeerLang: voiceMyLang });
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* ---- Drop overlay ---- */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-paper/80 backdrop-blur-[2px] pointer-events-none">
          <div className="flex flex-col items-center gap-4 rounded-card border-2 border-dashed border-cobalt bg-surface/95 px-14 py-10">
            <IconDownload size={48} className="text-cobalt" aria-hidden="true" />
            <p className="font-display text-h2 font-semibold text-cobalt-deep">
              {t("voice.dropOverlay")}
            </p>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 w-full max-w-[920px] mx-auto px-6 py-7 flex flex-col gap-6 lt-screen-in">
        {/* ---- Header row ---- */}
        <div className="flex items-center justify-between gap-4 shrink-0 min-h-14">
          <h1 className="font-display text-h1 font-semibold tracking-tight text-ink leading-none">
            {t("voice.title")}
          </h1>

          <div className="flex items-center gap-3">
            {/* TTS output voice for RECORDED (outgoing) messages — moved here from
                Settings so it lives next to the recorder it affects. */}
            <TtsVoiceSelect />
            {isRecording && (
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-emphasis text-ink tabular-nums">
                  {formatRecordingTime(recordingSecs)}
                </span>
                <span className="text-label text-muted">{t("voice.recordCap")}</span>
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
                className={`lt-press relative flex items-center justify-center w-14 h-14 rounded-full text-white lt-card ${
                  isRecording
                    ? "bg-tangerine hover:bg-tangerine-deep"
                    : "bg-cobalt hover:bg-cobalt-deep lt-glow"
                }`}
              >
                {isRecording ? <IconStopSquare size={22} /> : <IconMic size={22} />}
              </button>
            </div>
          </div>
        </div>

        {/* ---- Voice-message settings: language pair + mic (independent of live) ---- */}
        <div className="flex items-end gap-2 flex-wrap shrink-0">
          <div className="flex flex-col gap-1">
            <span className="text-label text-cobalt-deep font-medium px-1 leading-none">
              {t("voice.lang.you")}
            </span>
            <VoiceLangSelect
              value={voiceMyLang}
              onChange={(c) => void patchSettings({ voiceMyLang: c })}
              ariaLabel={t("voice.lang.you")}
              tone="out"
            />
          </div>
          <button
            onClick={handleSwapVoiceLangs}
            aria-label={t("voice.lang.swap")}
            className="lt-swap mb-0.5 inline-flex items-center justify-center w-8 h-8 rounded-full border border-hairline bg-surface text-muted hover:text-cobalt hover:border-cobalt/40"
          >
            <IconSwap size={15} />
          </button>
          <div className="flex flex-col gap-1">
            <span className="text-label text-muted font-medium px-1 leading-none">
              {t("voice.lang.peer")}
            </span>
            <VoiceLangSelect
              value={voicePeerLang}
              onChange={(c) => void patchSettings({ voicePeerLang: c })}
              ariaLabel={t("voice.lang.peer")}
              tone="in"
            />
          </div>
          <div className="ml-auto w-full sm:w-auto sm:min-w-[220px] sm:max-w-[300px]">
            <DeviceSelect
              value={settings?.voiceMicId ?? null}
              onChange={(v) => void patchSettings({ voiceMicId: v })}
              label={t("voice.micLabel")}
              options={voiceMicOptions}
              sysDefault={sysDefault}
              onOpen={() => void refreshDevices()}
            />
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
        <div
          role="region"
          aria-label={t("voice.dropHint")}
          className="flex items-center justify-center gap-2 rounded-card border border-dashed border-hairline-strong py-3 text-caption text-muted shrink-0"
        >
          <IconDownload size={15} aria-hidden="true" />
          {t("voice.dropHint")}
        </div>

        {/* ---- Card list ---- */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 -mx-1 px-1">
          {voiceMessages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center px-6">
              <span
                aria-hidden="true"
                className="flex items-center justify-center w-20 h-20 rounded-card bg-surface-2 text-muted"
              >
                <IconMicMessage size={36} />
              </span>
              <p className="text-caption text-muted whitespace-pre-line max-w-sm leading-relaxed text-pretty">
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

/**
 * Compact language picker for the voice-message pair (mono code + native name),
 * mirroring the Header's live-mode LangPill but bound to the voice-specific
 * settings so the two modes can target different languages.
 */
function VoiceLangSelect({
  value,
  onChange,
  ariaLabel,
  tone,
}: {
  value: string;
  onChange: (code: string) => void;
  ariaLabel: string;
  tone: "out" | "in";
}) {
  const ring =
    tone === "out"
      ? "border-cobalt/25 hover:border-cobalt/55 focus-within:border-cobalt/55"
      : "border-hairline hover:border-hairline-strong focus-within:border-hairline-strong";
  const codeColor = tone === "out" ? "text-cobalt" : "text-muted";
  return (
    <SelectRoot
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      aria-label={ariaLabel}
    >
      <SelectTrigger
        className={`lt-press inline-flex items-center gap-2 h-9 pl-2.5 pr-3.5 rounded-pill border bg-surface text-caption font-medium text-ink ${ring}`}
      >
        <span className={`font-mono text-label font-semibold leading-none ${codeColor}`}>
          {langLabel(value)}
        </span>
        <span className="leading-none">{langAutonym(value)}</span>
      </SelectTrigger>
      <SelectPopover>
        <ListBox items={LANGUAGES} className="max-h-72 overflow-y-auto">
          {(lang) => (
            <ListBoxItem key={lang.code} id={lang.code} textValue={lang.autonym}>
              <span className="font-mono text-label text-muted mr-2">
                {langLabel(lang.code)}
              </span>
              {lang.autonym}
            </ListBoxItem>
          )}
        </ListBox>
      </SelectPopover>
    </SelectRoot>
  );
}

/**
 * Output-voice picker for recorded (outgoing) voice messages. Bound to the same
 * `settings.ttsVoice` the backend uses, so moving it here from Settings needs no
 * new state or schema — the record/retry commands already read this setting.
 */
function TtsVoiceSelect() {
  const { t } = useTranslation();
  const provider = useAppStore((s) => s.settings?.ttsProvider ?? "gemini");
  const ttsVoice = useAppStore((s) => s.settings?.ttsVoice ?? "Kore");
  const patchSettings = useAppStore((s) => s.patchSettings);
  const [voices, setVoices] = useState<string[]>([]);

  useEffect(() => {
    ipc
      .ttsVoices()
      .then((v) => setVoices(Array.isArray(v) ? v : []))
      .catch(() => setVoices([]));
  }, []);

  // When the cloned voice is the active provider, the Gemini voice picker no
  // longer applies — show a compact indicator instead (the voice id is managed
  // in Settings).
  if (provider === "elevenlabs") {
    return (
      <span className="inline-flex items-center gap-1.5 h-9 px-3 rounded-pill border border-cobalt/30 bg-cobalt-tint text-caption font-medium text-cobalt-deep">
        {t("voice.voiceCloneLabel")}
      </span>
    );
  }

  const items = (voices?.length ? voices : [ttsVoice]).map((v) => ({ id: v }));

  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-muted shrink-0 hidden sm:inline">
        {t("voice.voiceLabel")}
      </span>
      <SelectRoot
        selectedKey={ttsVoice}
        onSelectionChange={(key) => void patchSettings({ ttsVoice: String(key) })}
        aria-label={t("voice.voiceLabel")}
      >
        <SelectTrigger className="lt-press inline-flex items-center gap-2 h-9 pl-3 pr-2.5 rounded-pill border border-hairline bg-surface text-caption text-ink hover:border-hairline-strong min-w-[120px]">
          <SelectValue className="flex-1 text-left truncate" />
          <SelectIndicator />
        </SelectTrigger>
        <SelectPopover>
          <ListBox items={items} className="max-h-72 overflow-y-auto">
            {(item) => (
              <ListBoxItem key={item.id} id={item.id} textValue={item.id}>
                {item.id}
              </ListBoxItem>
            )}
          </ListBox>
        </SelectPopover>
      </SelectRoot>
    </div>
  );
}
