import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialogBackdrop,
  AlertDialogBody,
  AlertDialogContainer,
  AlertDialogDialog,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogHeading,
  AlertDialogRoot,
  AlertDialogTrigger,
  Button,
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectIndicator,
  SelectPopover,
  SelectTrigger,
  SelectValue,
  Switch,
  SwitchContent,
  SwitchControl,
  SwitchThumb,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { DirectionMeter } from "../components/LevelMeter";
import { TranscriptFeed } from "../components/TranscriptFeed";
import { Banner } from "../components/Banner";
import { IconWaveform } from "../components/Icons";
import { DeviceSelect, buildDeviceOptions } from "./SettingsScreen";
import { looksLikeHeadphones, looksLikeSpeakers, isLoopbackCaptureDevice } from "../lib/echo";
import { formatDuration } from "../lib/format";

export function LiveScreen() {
  const { t } = useTranslation();

  const settings = useAppStore((s) => s.settings);
  const keyStatus = useAppStore((s) => s.keyStatus);
  const devices = useAppStore((s) => s.devices);
  const apps = useAppStore((s) => s.apps);
  const liveState = useAppStore((s) => s.liveState);
  const transcript = useAppStore((s) => s.transcript);
  const lastError = useAppStore((s) => s.lastError);
  const notice = useAppStore((s) => s.notice);
  const appPid = useAppStore((s) => s.appPid);
  const setAppPid = useAppStore((s) => s.setAppPid);
  const refreshApps = useAppStore((s) => s.refreshApps);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const setScreen = useAppStore((s) => s.setScreen);
  const setLastError = useAppStore((s) => s.setLastError);
  const setNotice = useAppStore((s) => s.setNotice);

  // Clear-transcript confirmation dialog
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  const captureMode = settings?.captureMode ?? "system";
  const cablePresent = devices?.cablePresent ?? false;

  // Echo warning: resolve the device the user will actually hear on — the chosen
  // output, or (when left on "system default") whatever Windows marks default —
  // and warn when it looks like loudspeakers. Acoustic feedback through speakers
  // is the dominant cause of "the peer hears themselves". Previously the warning
  // was skipped entirely when no output was explicitly picked (the common case
  // for a non-technical user), so it never showed; now it covers the default too.
  const effectiveOutputName = (() => {
    const outs = devices?.outputs ?? [];
    if (settings?.outputId) {
      return outs.find((d) => d.id === settings.outputId)?.name ?? null;
    }
    return outs.find((d) => d.isDefault)?.name ?? null;
  })();
  const showEchoWarning =
    effectiveOutputName != null &&
    !looksLikeHeadphones(effectiveOutputName) &&
    looksLikeSpeakers(effectiveOutputName);

  // Map error keys to translated messages at render time. Known backend codes
  // map to friendly copy; any other raw string is wrapped in the generic
  // fallback (STATE-6) so a bare backend token never reaches the banner.
  function translateError(err: string | null): string | null {
    if (!err) return null;
    if (err === "no_api_key") return t("live.error.noApiKey");
    if (err === "already_running") return t("live.error.alreadyRunning");
    if (err === "cable_missing") return t("live.error.cableMissing");
    if (err === "no_app_selected") return t("live.error.noAppSelected");
    // Messages already produced through i18n (start with a localized sentence,
    // not a snake_case token) pass through untouched; raw tokens get wrapped.
    if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(err)) {
      return t("live.error.generic", { raw: err });
    }
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

  // Live-mode device options (mic hides loopback/monitor endpoints, same as
  // Settings). These pickers persist `micId`/`outputId` — the LIVE devices,
  // independent of the voice-message mic.
  const micOptions = buildDeviceOptions(
    (devices?.inputs ?? []).filter((d) => !isLoopbackCaptureDevice(d.name))
  );
  const outputOptions = buildDeviceOptions(devices?.outputs ?? []);
  const sysDefault = t("settings.audio.systemDefault");

  // The live setup (languages, echo) is sent once per connection and can't be
  // re-targeted mid-session, so session-scoped controls lock while running —
  // mirroring the header language pills.
  const phase = liveState?.phase ?? "off";
  const sessionLive =
    phase === "running" || phase === "connecting" || phase === "reconnecting";

  return (
    <div className="flex-1 min-h-0 flex flex-col lt-screen-in">
      {/* Centered content column */}
      <div className="flex-1 min-h-0 w-full max-w-[920px] mx-auto px-6 pt-6 pb-0 flex flex-col gap-4">
        {/* ---- Toolbar: source picker ---- */}
        <div className="flex items-center gap-3 shrink-0 h-9">
          <span className="text-caption text-muted shrink-0">
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
            <SelectTrigger className="lt-press min-w-[240px] max-w-[420px] inline-flex items-center gap-2.5 h-9 pl-2.5 pr-3.5 rounded-pill border border-hairline bg-surface text-caption text-ink hover:border-hairline-strong">
              <span
                aria-hidden="true"
                className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md bg-cobalt-tint text-cobalt"
              >
                <IconWaveform size={15} />
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
                {apps.length === 0 ? (
                  <ListBoxItem
                    key="__no_apps__"
                    id="__no_apps__"
                    isDisabled
                    textValue={t("live.noAppsHint")}
                  >
                    <span className="text-muted text-caption">
                      {t("live.noAppsHint")}
                    </span>
                  </ListBoxItem>
                ) : (
                  apps.map((app) => (
                    <ListBoxItem
                      key={String(app.pid)}
                      id={String(app.pid)}
                      textValue={`${app.name} (${app.pid})`}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                            app.active ? "bg-cobalt" : "bg-hairline-strong"
                          }`}
                        />
                        <span>{app.name}</span>
                        <span className="font-mono text-muted">({app.pid})</span>
                      </span>
                    </ListBoxItem>
                  ))
                )}
              </ListBox>
            </SelectPopover>
          </SelectRoot>
        </div>

        {/* ---- Device pickers: mic + output (live-mode devices) ---- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 shrink-0">
          <DeviceSelect
            value={settings.micId}
            onChange={(v) => void patchSettings({ micId: v })}
            label={t("settings.audio.mic")}
            options={micOptions}
            sysDefault={sysDefault}
            onOpen={() => void refreshDevices()}
          />
          <DeviceSelect
            value={settings.outputId}
            onChange={(v) => void patchSettings({ outputId: v })}
            label={t("settings.audio.output")}
            options={outputOptions}
            sysDefault={sysDefault}
            onOpen={() => void refreshDevices()}
          />
        </div>

        {/* ---- Same-language passthrough (IN direction) ---- */}
        {/* Applies to the incoming peer→you direction and is sent once per
            connection, so it locks while a session runs (set it before Start). */}
        <div
          className="flex flex-col gap-1 shrink-0"
          title={sessionLive ? t("live.langLockedHint") : undefined}
        >
          <Switch
            isSelected={settings.echoTargetLanguage}
            onChange={(v) => void patchSettings({ echoTargetLanguage: v })}
            isDisabled={sessionLive}
            className="group flex items-center gap-3"
          >
            <SwitchControl className="data-[selected]:bg-cobalt">
              <SwitchThumb />
            </SwitchControl>
            <SwitchContent className="text-caption text-ink">
              {t("settings.translation.echoTargetLanguage")}
            </SwitchContent>
          </Switch>
          <p className="text-label text-muted leading-snug ml-11 max-w-prose">
            {t("live.echoSessionHint")}
          </p>
        </div>

        {/* ---- Banners ---- */}
        {(keyStatus?.state !== "valid" ||
          !cablePresent ||
          showEchoWarning ||
          notice ||
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
              />
            )}
            {notice && (
              <Banner
                tone="warn"
                description={notice}
                onDismiss={() => setNotice(null)}
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
        <div className="relative flex-1 min-h-0 bg-surface border border-hairline rounded-card lt-card overflow-hidden flex flex-col">
          <TranscriptFeed lines={transcript} />
          {transcript.length > 0 && (
            <div className="absolute top-2.5 right-2.5 z-10">
              <AlertDialogRoot
                isOpen={clearDialogOpen}
                onOpenChange={(open) => {
                  if (!open) setClearDialogOpen(false);
                }}
              >
                <AlertDialogTrigger>
                  <button
                    onClick={() => setClearDialogOpen(true)}
                    className="lt-press px-3 h-7 rounded-pill text-caption text-muted hover:text-ink hover:bg-surface-2"
                  >
                    {t("live.clearTranscript")}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogBackdrop isDismissable>
                  <AlertDialogContainer>
                    <AlertDialogDialog>
                      <AlertDialogHeader>
                        <AlertDialogHeading>
                          {t("live.confirmClearTitle")}
                        </AlertDialogHeading>
                      </AlertDialogHeader>
                      <AlertDialogBody>
                        <p className="text-body text-ink-2">
                          {t("live.confirmClearBody")}
                        </p>
                      </AlertDialogBody>
                      <AlertDialogFooter>
                        <Button
                          variant="outline"
                          size="sm"
                          onPress={() => setClearDialogOpen(false)}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onPress={() => {
                            clearTranscript();
                            setClearDialogOpen(false);
                          }}
                        >
                          {t("live.confirmClearOk")}
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogDialog>
                  </AlertDialogContainer>
                </AlertDialogBackdrop>
              </AlertDialogRoot>
            </div>
          )}
        </div>
      </div>

      {/* ---- Status strip: three zones (sessions | meters | time+cost) ---- */}
      <div className="shrink-0 border-t border-hairline bg-surface">
        <div className="w-full max-w-[920px] mx-auto px-6 h-12 flex items-center gap-4">
          {/* Zone 1 — sessions */}
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

          <span className="w-px h-6 bg-hairline shrink-0" />

          {/* Zone 2 — meters (self-subscribes to levels → isolates 10Hz). */}
          <MetersZone />

          <div className="flex-1" />

          <span className="w-px h-6 bg-hairline shrink-0" />

          {/* Zone 3 — time + cost (self-subscribes to cost + durationSec). */}
          <TimeCostZone />
        </div>
      </div>
    </div>
  );
}

// ----------- Sub-components -----------

/**
 * Status-strip meters. Subscribes to `levels` itself so the 10Hz level stream
 * only re-renders THIS leaf, not the whole LiveScreen (and not the transcript).
 */
function MetersZone() {
  const { t } = useTranslation();
  const levels = useAppStore((s) => s.levels);
  return (
    <div className="flex flex-col gap-1.5">
      <DirectionMeter db={levels?.micDb ?? -60} tone="out" label={t("live.levelMic")} />
      <DirectionMeter db={levels?.appDb ?? -60} tone="in" label={t("live.levelApp")} />
    </div>
  );
}

/**
 * Status-strip time + estimated cost. Subscribes to `cost` and `durationSec`
 * itself, isolating those (~1Hz) updates from the rest of LiveScreen.
 */
function TimeCostZone() {
  const { t } = useTranslation();
  const cost = useAppStore((s) => s.cost);
  const durationSec = useAppStore((s) => s.durationSec);
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-label text-ink tabular-nums px-2 py-1 rounded-md bg-surface-2">
        {cost != null ? formatDuration(cost.seconds) : formatDuration(durationSec)}
      </span>
      {cost != null && (
        <Tooltip>
          <TooltipTrigger>
            <span className="font-mono text-label text-muted tabular-nums px-2 py-1 rounded-md bg-surface-2">
              ~${cost.estimatedUsd.toFixed(2)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("live.costTooltip")}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

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
    cls = "border border-danger/50 text-danger bg-danger-tint";
  } else {
    cls = "border border-hairline text-muted bg-surface-2";
  }

  const chip = (
    <span
      className={`inline-flex items-center h-7 px-3 rounded-pill text-label font-medium ${cls}`}
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
