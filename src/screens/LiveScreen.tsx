import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
import { DirectionMeter } from "../components/LevelMeter";
import { TranscriptFeed } from "../components/TranscriptFeed";
import { Banner } from "../components/Banner";
import { looksLikeHeadphones } from "../lib/echo";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  const durationSec = useAppStore((s) => s.durationSec);
  const appPid = useAppStore((s) => s.appPid);
  const setAppPid = useAppStore((s) => s.setAppPid);
  const refreshApps = useAppStore((s) => s.refreshApps);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const setScreen = useAppStore((s) => s.setScreen);
  const setLastError = useAppStore((s) => s.setLastError);

  // Dismissable echo warning
  const [echoDismissed, setEchoDismissed] = useState(false);

  const captureMode = settings?.captureMode ?? "system";
  const cablePresent = devices?.cablePresent ?? false;

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

  // Build app list items
  const systemAudioLabel = t("live.systemAudio");
  const APP_SYSTEM_KEY = "__system__";

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Centered content column */}
      <div className="flex-1 min-h-0 w-full max-w-[920px] mx-auto px-6 pt-5 pb-0 flex flex-col gap-3">
        {/* ---- Toolbar: source picker ---- */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted shrink-0">
            {t("live.audioSource")}
          </span>
          <SelectRoot
            selectedKey={
              captureMode === "system"
                ? APP_SYSTEM_KEY
                : appPid != null
                  ? String(appPid)
                  : null
            }
            placeholder={t("live.pickAppPlaceholder")}
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
            <SelectTrigger className="min-w-[240px] max-w-[420px] inline-flex items-center gap-2.5 h-9 pl-3 pr-3.5 rounded-pill border border-hairline bg-surface text-[13px] text-ink hover:border-stone-300 transition-colors">
              <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md bg-cobalt-tint text-cobalt text-[11px]">
                ♪
              </span>
              <SelectValue className="flex-1 min-w-0 text-left truncate" />
              <SelectIndicator className="shrink-0" />
            </SelectTrigger>
            <SelectPopover>
              <ListBox className="max-h-72 overflow-y-auto">
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
                    {app.active ? "🔊 " : ""}
                    {app.name}{" "}
                    <span className="font-mono text-muted">({app.pid})</span>
                  </ListBoxItem>
                ))}
              </ListBox>
            </SelectPopover>
          </SelectRoot>
        </div>

        {/* ---- Banners ---- */}
        {(keyStatus?.state !== "valid" ||
          !cablePresent ||
          showEchoWarning ||
          displayedError) && (
          <div className="flex flex-col gap-2 shrink-0">
            {keyStatus && keyStatus.state !== "valid" && (
              <Banner
                tone="warn"
                title={t("live.alertNoKey")}
                description={t("live.alertNoKeyDesc")}
                action={{ label: t("live.alertGoSettings"), onClick: () => setScreen("settings") }}
              />
            )}
            {!cablePresent && (
              <Banner
                tone="danger"
                title={t("live.alertNoCable")}
                description={t("live.alertNoCableDesc")}
                action={{ label: t("settings.audio.wizardButton"), onClick: () => setScreen("wizard") }}
              />
            )}
            {showEchoWarning && (
              <Banner
                tone="warn"
                title={t("live.alertEcho")}
                description={t("live.alertEchoDesc")}
                onDismiss={() => setEchoDismissed(true)}
              />
            )}
            {displayedError && (
              <Banner
                tone="danger"
                title={t("common.error")}
                description={displayedError}
                onDismiss={() => setLastError(null)}
              />
            )}
          </div>
        )}

        {/* ---- Transcript card (fills) ---- */}
        <div className="relative flex-1 min-h-0 bg-surface border border-hairline rounded-card shadow-studio overflow-hidden flex flex-col">
          <TranscriptFeed lines={transcript} />
          {transcript.length > 0 && (
            <div className="absolute top-2.5 right-2.5 z-10">
              <button
                onClick={clearTranscript}
                className="px-3 h-7 rounded-pill text-[12px] text-muted hover:text-ink hover:bg-stone-100 transition-colors"
              >
                {t("live.clearTranscript")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Status strip ---- */}
      <div className="shrink-0 border-t border-hairline bg-surface">
        <div className="w-full max-w-[920px] mx-auto px-6 py-2.5 flex items-center gap-4 flex-wrap">
          {/* Direction chips */}
          <div className="flex items-center gap-2">
            <DirectionChip
              session={liveState?.outSession ?? "off"}
              tone="out"
              label={t("live.sessionOut")}
            />
            <DirectionChip
              session={liveState?.inSession ?? "off"}
              tone="in"
              label={t("live.sessionIn")}
            />
          </div>

          {/* Meters */}
          <div className="flex flex-col gap-1 ml-2">
            <DirectionMeter db={levels?.micDb ?? -60} tone="out" label={t("live.levelMic")} />
            <DirectionMeter db={levels?.appDb ?? -60} tone="in" label={t("live.levelApp")} />
          </div>

          <div className="flex-1" />

          {/* Timer + cost */}
          <span className="font-mono text-[12px] text-ink tabular-nums">
            {cost != null ? formatDuration(cost.seconds) : formatDuration(durationSec)}
          </span>
          {cost != null && (
            <Tooltip>
              <TooltipTrigger>
                <span className="font-mono text-[12px] text-muted tabular-nums px-2 py-0.5 rounded-md bg-stone-100">
                  ~${cost.estimatedUsd.toFixed(2)}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("live.costTooltip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------- Sub-components -----------

function DirectionChip({
  session,
  tone,
  label,
}: {
  session: string;
  tone: "out" | "in";
  label: string;
}) {
  const isOff = session === "off";
  const isRunning = session === "running";
  const isReconnecting = session === "reconnecting" || session === "connecting";
  const isError = !isOff && !isRunning && !isReconnecting;

  const accentBg = tone === "out" ? "bg-cobalt" : "bg-tangerine";
  const accentText = tone === "out" ? "text-cobalt-deep" : "text-tangerine-deep";
  const accentBorder = tone === "out" ? "border-cobalt/50" : "border-tangerine/50";
  const accentTint = tone === "out" ? "bg-cobalt-tint" : "bg-tangerine-tint";

  let cls: string;
  if (isRunning) {
    cls = `${accentBg} text-white`;
  } else if (isReconnecting) {
    cls = `border ${accentBorder} ${accentText} ${accentTint} lt-pulse-dot`;
  } else if (isError) {
    cls = "border border-danger/50 text-danger bg-danger/5";
  } else {
    cls = "border border-hairline text-muted bg-stone-50";
  }

  const chip = (
    <span
      className={`inline-flex items-center h-6 px-2.5 rounded-pill text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
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
