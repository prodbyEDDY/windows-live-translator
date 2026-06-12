import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Chip,
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectIndicator,
  SelectPopover,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { LanguagePair } from "../components/LanguagePair";
import { LevelMeter } from "../components/LevelMeter";
import { TranscriptFeed } from "../components/TranscriptFeed";
import { canStart } from "../lib/liveStart";
import { looksLikeHeadphones } from "../lib/echo";
import { ipc } from "../lib/ipc";
import { shouldSaveCall } from "../lib/history";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function sessionColor(
  session: string
): "success" | "warning" | "danger" | "default" {
  if (session === "running") return "success";
  if (session === "connecting" || session === "reconnecting") return "warning";
  if (session === "off") return "default";
  return "danger"; // error strings
}

function sessionLabel(session: string, t: (k: string) => string): string {
  if (session === "off") return t("live.sessionOff");
  if (session === "connecting") return t("live.sessionConnecting");
  if (session === "running") return t("live.sessionRunning");
  if (session === "reconnecting") return t("live.sessionReconnecting");
  return session; // error message passthrough
}

export function LiveScreen() {
  const { t } = useTranslation();

  const settings = useAppStore((s) => s.settings);
  const keyStatus = useAppStore((s) => s.keyStatus);
  const devices = useAppStore((s) => s.devices);
  const apps = useAppStore((s) => s.apps);
  const liveState = useAppStore((s) => s.liveState);
  const transcript = useAppStore((s) => s.transcript);
  const levels = useAppStore((s) => s.levels);
  const cost = useAppStore((s) => s.cost);
  const lastError = useAppStore((s) => s.lastError);
  const startLive = useAppStore((s) => s.startLive);
  const stopLive = useAppStore((s) => s.stopLive);
  const refreshApps = useAppStore((s) => s.refreshApps);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const setScreen = useAppStore((s) => s.setScreen);
  const setLastError = useAppStore((s) => s.setLastError);

  // Local state: selected app pid for "app" capture mode
  const [appPid, setAppPid] = useState<number | null>(null);
  // Dismissable echo warning
  const [echoDismissed, setEchoDismissed] = useState(false);
  // Session duration timer
  const [durationSec, setDurationSec] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const captureMode = settings?.captureMode ?? "system";
  const cablePresent = devices?.cablePresent ?? false;

  // Determine current phase
  const phase = liveState?.phase ?? "off";
  const isRunning = phase === "running" || phase === "connecting" || phase === "reconnecting";

  // Start/stop timer when phase changes
  useEffect(() => {
    if (phase === "running") {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => {
          setDurationSec((s) => s + 1);
        }, 1000);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (phase === "off") {
        setDurationSec(0);
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [phase]);

  const startResult = canStart(keyStatus, captureMode, appPid, cablePresent);

  async function handleStart() {
    if (!settings) return;
    clearTranscript();
    const cfg = {
      myLang: settings.myLang,
      peerLang: settings.peerLang,
      micId: settings.micId,
      outputId: settings.outputId,
      captureMode: settings.captureMode,
      appPid: captureMode === "app" ? appPid : null,
      echoTargetLanguage: settings.echoTargetLanguage,
      duckingEnabled: settings.duckingEnabled,
      duckLevel: settings.duckLevel,
      mixOriginal: settings.mixOriginal,
      mixGainDb: settings.mixGainDb,
      testMode: false,
    };
    await startLive(cfg);
  }

  async function handleStop() {
    // Save transcript before stopping (only if there is meaningful content).
    // A crashed/interrupted call loses its transcript — acceptable v1 behaviour.
    if (settings && shouldSaveCall(transcript)) {
      try {
        await ipc.historySaveCall(
          settings.myLang,
          settings.peerLang,
          durationSec,
          JSON.stringify(transcript)
        );
      } catch {
        // Non-fatal: losing the history record is preferable to blocking stop
      }
    }
    await stopLive();
  }

  // Echo warning: check if output device name looks like headphones
  const outputDeviceName = (() => {
    if (!settings?.outputId) return null;
    return devices?.outputs.find((d) => d.id === settings.outputId)?.name ?? null;
  })();
  const showEchoWarning =
    !echoDismissed &&
    outputDeviceName != null &&
    !looksLikeHeadphones(outputDeviceName);

  // Map error keys to translated messages at render time
  function translateError(err: string | null): string | null {
    if (!err) return null;
    if (err === "no_api_key") return t("live.error.noApiKey");
    if (err === "already_running") return t("live.error.alreadyRunning");
    if (err === "cable_missing") return t("live.error.cableMissing");
    if (err === "no_app_selected") return t("live.error.noAppSelected");
    return err;
  }

  const displayedError = translateError(lastError);

  // Build app list items: "системный звук" + each app
  const systemAudioLabel = t("live.systemAudio");
  const APP_SYSTEM_KEY = "__system__";

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ---- Header ---- */}
      <div className="flex flex-col gap-3 p-4 border-b border-gray-200 bg-white">
        {/* Language pair */}
        <LanguagePair />

        {/* Source selector + Start/Stop */}
        <div className="flex items-end gap-3">
          {/* App source selector */}
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <label className="text-xs text-gray-500">{t("live.audioSource")}</label>
            <SelectRoot
              selectedKey={captureMode === "system" ? APP_SYSTEM_KEY : (appPid != null ? String(appPid) : APP_SYSTEM_KEY)}
              onSelectionChange={(key) => {
                if (key === APP_SYSTEM_KEY) {
                  void useAppStore.getState().patchSettings({ captureMode: "system" });
                  setAppPid(null);
                } else {
                  const pid = Number(key);
                  void useAppStore.getState().patchSettings({ captureMode: "app" });
                  setAppPid(pid);
                }
              }}
              aria-label={t("live.audioSource")}
              onOpenChange={(open) => {
                if (open) void refreshApps();
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
                <SelectIndicator />
              </SelectTrigger>
              <SelectPopover>
                <ListBox>
                  <ListBoxItem
                    key={APP_SYSTEM_KEY}
                    id={APP_SYSTEM_KEY}
                    textValue={systemAudioLabel}
                  >
                    {systemAudioLabel}
                  </ListBoxItem>
                  {apps.map((app) => (
                    <ListBoxItem
                      key={String(app.pid)}
                      id={String(app.pid)}
                      textValue={`${app.name} (${app.pid})`}
                    >
                      {app.name} ({app.pid})
                    </ListBoxItem>
                  ))}
                </ListBox>
              </SelectPopover>
            </SelectRoot>
          </div>

          {/* Start / Stop button */}
          <div className="flex flex-col items-end gap-1">
            {isRunning ? (
              <Button
                variant="danger"
                className="min-w-24"
                onPress={() => void handleStop()}
              >
                {t("common.stop")}
              </Button>
            ) : startResult.ok ? (
              <Button
                variant="primary"
                className="min-w-24"
                onPress={() => void handleStart()}
              >
                {t("common.start")}
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="outline"
                    isDisabled
                    className="min-w-24"
                  >
                    {t("common.start")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {startResult.reason ? t(startResult.reason) : ""}
                </TooltipContent>
              </Tooltip>
            )}
            {/* Hint text under button */}
            {!isRunning && !startResult.ok && startResult.reason && (
              <span className="text-xs text-orange-500">
                {t(startResult.reason)}
              </span>
            )}
          </div>
        </div>

        {/* Warning banners */}
        <div className="flex flex-col gap-2">
          {/* API key missing/invalid */}
          {keyStatus && keyStatus.state !== "valid" && (
            <Alert status="warning" className="flex items-start gap-3 py-2">
              <div className="flex-1">
                <AlertTitle className="text-sm">{t("live.alertNoKey")}</AlertTitle>
                <AlertDescription className="text-xs">
                  {t("live.alertNoKeyDesc")}
                </AlertDescription>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="flex-shrink-0"
                onPress={() => setScreen("settings")}
              >
                {t("live.alertGoSettings")}
              </Button>
            </Alert>
          )}

          {/* VB-Cable not present */}
          {!cablePresent && (
            <Alert status="danger" className="flex items-start gap-3 py-2">
              <div className="flex-1">
                <AlertTitle className="text-sm">{t("live.alertNoCable")}</AlertTitle>
                <AlertDescription className="text-xs">
                  {t("live.alertNoCableDesc")}
                </AlertDescription>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="flex-shrink-0"
                onPress={() => setScreen("wizard")}
              >
                {t("settings.audio.wizardButton")}
              </Button>
            </Alert>
          )}

          {/* Echo warning */}
          {showEchoWarning && (
            <Alert status="warning" className="flex items-start gap-3 py-2">
              <div className="flex-1">
                <AlertTitle className="text-sm">{t("live.alertEcho")}</AlertTitle>
                <AlertDescription className="text-xs">
                  {t("live.alertEchoDesc")}
                </AlertDescription>
              </div>
              <button
                onClick={() => setEchoDismissed(true)}
                className="text-gray-400 hover:text-gray-600 ml-2 flex-shrink-0 text-sm"
                aria-label={t("common.cancel")}
              >
                ✕
              </button>
            </Alert>
          )}

          {/* Start/runtime error */}
          {displayedError && (
            <Alert status="danger" className="flex items-start gap-3 py-2">
              <div className="flex-1">
                <AlertTitle className="text-sm">{t("common.error")}</AlertTitle>
                <AlertDescription className="text-xs">{displayedError}</AlertDescription>
              </div>
              <button
                onClick={() => setLastError(null)}
                className="text-gray-400 hover:text-gray-600 ml-2 flex-shrink-0 text-sm"
                aria-label={t("common.cancel")}
              >
                ✕
              </button>
            </Alert>
          )}
        </div>
      </div>

      {/* ---- Body: TranscriptFeed + clear button ---- */}
      <div className="flex-1 flex flex-col min-h-0 relative">
        <TranscriptFeed lines={transcript} />

        {/* Clear transcript button */}
        {transcript.length > 0 && (
          <div className="absolute top-2 right-2 z-10">
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-gray-400 hover:text-gray-600"
              onPress={clearTranscript}
            >
              {t("live.clearTranscript")}
            </Button>
          </div>
        )}
      </div>

      {/* ---- Status bar ---- */}
      <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-200 bg-gray-50 flex-wrap">
        {/* Session chips */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">{t("live.sessionOut")}:</span>
          <SessionChip
            session={liveState?.outSession ?? "off"}
            reconnecting={liveState?.outSession === "reconnecting"}
            t={t}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">{t("live.sessionIn")}:</span>
          <SessionChip
            session={liveState?.inSession ?? "off"}
            reconnecting={liveState?.inSession === "reconnecting"}
            t={t}
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Level meters */}
        <div className="flex flex-col gap-1 min-w-32">
          <LevelMeter
            db={levels?.micDb ?? -60}
            label={t("live.levelMic")}
          />
          <LevelMeter
            db={levels?.appDb ?? -60}
            label={t("live.levelApp")}
          />
        </div>

        {/* Duration + cost */}
        <span className="text-xs font-mono text-gray-500 tabular-nums min-w-10 text-right">
          {cost != null ? formatDuration(cost.seconds) : formatDuration(durationSec)}
        </span>
        {cost != null && (
          <Tooltip>
            <TooltipTrigger>
              <Chip size="sm" color="default" className="text-xs font-mono">
                ~${cost.estimatedUsd.toFixed(2)}
              </Chip>
            </TooltipTrigger>
            <TooltipContent>{t("live.costTooltip")}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ----------- Sub-components -----------

interface SessionChipProps {
  session: string;
  reconnecting: boolean;
  t: (k: string) => string;
}

function SessionChip({ session, reconnecting, t }: SessionChipProps) {
  const color = sessionColor(session);
  const label = sessionLabel(session, t);
  const isError =
    session !== "off" &&
    session !== "connecting" &&
    session !== "running" &&
    session !== "reconnecting";

  const chip = (
    <Chip
      color={color}
      size="sm"
      className={reconnecting ? "animate-pulse" : undefined}
    >
      {label}
    </Chip>
  );

  if (isError) {
    return (
      <Tooltip>
        <TooltipTrigger>{chip}</TooltipTrigger>
        <TooltipContent>{session}</TooltipContent>
      </Tooltip>
    );
  }

  return chip;
}
