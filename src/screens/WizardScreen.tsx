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
  Spinner,
} from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/app";
import { ApiKeyField } from "../components/ApiKeyField";
import { TranscriptFeed } from "../components/TranscriptFeed";
import { Banner } from "../components/Banner";
import { WaveformGlyph, IconCheck } from "../components/Icons";
import { buildDeviceOptions } from "./SettingsScreen";
import { looksLikeHeadphones } from "../lib/echo";
import { ipc } from "../lib/ipc";
import {
  WIZARD_STEPS,
  CABLE_PAGE_URL,
  AI_STUDIO_URL,
  installErrorKey,
  isDownloadError,
  buildTestConfig,
} from "../lib/wizard";

const REBOOT_HINT_AFTER_MS = 30_000;
const CABLE_POLL_MS = 2_000;

export function WizardScreen() {
  const { t } = useTranslation();

  const settings = useAppStore((s) => s.settings);
  const keyStatus = useAppStore((s) => s.keyStatus);
  const devices = useAppStore((s) => s.devices);
  const liveState = useAppStore((s) => s.liveState);
  const transcript = useAppStore((s) => s.transcript);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const startLive = useAppStore((s) => s.startLive);
  const stopLive = useAppStore((s) => s.stopLive);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const setScreen = useAppStore((s) => s.setScreen);

  const [stepIdx, setStepIdx] = useState(0);
  const step = WIZARD_STEPS[stepIdx];

  if (!settings) {
    return (
      <div className="relative z-10 flex-1 flex items-center justify-center h-full">
        <span className="text-muted">{t("common.loading")}</span>
      </div>
    );
  }

  const cablePresent = devices?.cablePresent ?? false;
  const keyValid = keyStatus?.state === "valid";

  const canAdvance =
    step === "key" ? keyValid : step === "cable" ? cablePresent : true;

  function goNext() {
    setStepIdx((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  }
  function goBack() {
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  async function finish() {
    await stopLive();
    await patchSettings({ wizardDone: true });
    setScreen("live");
  }

  const stepTitles: Record<string, string> = {
    key: t("wizard.key.heading"),
    cable: t("wizard.cable.heading"),
    devices: t("wizard.devices.heading"),
    test: t("wizard.test.heading"),
  };

  return (
    <div className="relative z-10 h-full overflow-y-auto flex flex-col items-center px-6 py-10">
      <div className="w-full max-w-[560px] flex flex-col gap-6">
        {/* Wordmark */}
        <div className="flex items-center gap-2.5 justify-center">
          <WaveformGlyph active={false} />
          <span className="font-display text-[13px] font-semibold tracking-[0.14em] text-ink">
            LIVE&nbsp;TRANSLATOR
          </span>
        </div>

        <StepProgress current={stepIdx} />

        <div className="bg-surface border border-hairline rounded-card shadow-studio p-6 flex flex-col gap-5">
          <h2 className="font-display text-[18px] font-semibold tracking-tight text-ink">
            {stepTitles[step]}
          </h2>

          {step === "key" && <StepKey keyValid={keyValid} t={t} />}
          {step === "cable" && (
            <StepCable cablePresent={cablePresent} refreshDevices={refreshDevices} t={t} />
          )}
          {step === "devices" && <StepDevices t={t} />}
          {step === "test" && (
            <StepTest
              settings={settings}
              liveState={liveState}
              transcript={transcript}
              startLive={startLive}
              stopLive={stopLive}
              clearTranscript={clearTranscript}
              t={t}
            />
          )}

          {/* ---- Navigation ---- */}
          <div className="flex items-center justify-between pt-2 border-t border-hairline">
            <button
              onClick={goBack}
              disabled={stepIdx === 0}
              className="px-4 h-10 rounded-pill border border-hairline text-[13px] text-ink hover:border-stone-300 disabled:opacity-40 transition-colors"
            >
              {t("common.back")}
            </button>

            {step === "test" ? (
              <button
                onClick={() => void finish()}
                className="px-5 h-10 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white text-[13px] font-medium transition-colors"
              >
                {t("wizard.test.allWorks")}
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={!canAdvance}
                className="px-5 h-10 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white text-[13px] font-medium disabled:opacity-40 disabled:hover:bg-cobalt transition-colors"
              >
                {t("common.next")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbered progress
// ---------------------------------------------------------------------------

function StepProgress({ current }: { current: number }) {
  const { t } = useTranslation();
  const labels = [
    t("wizard.steps.key"),
    t("wizard.steps.cable"),
    t("wizard.steps.devices"),
    t("wizard.steps.test"),
  ];
  return (
    <div className="flex items-start">
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={label} className="flex items-start flex-1 min-w-0">
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <div
                className={`flex items-center justify-center w-7 h-7 rounded-full text-[12px] font-mono font-medium transition-colors ${
                  active
                    ? "bg-cobalt text-white"
                    : done
                      ? "bg-cobalt text-white"
                      : "bg-stone-100 text-muted border border-hairline"
                }`}
              >
                {done ? <IconCheck size={14} /> : i + 1}
              </div>
              <span
                className={`text-[11px] text-center truncate max-w-16 ${
                  active ? "text-ink font-medium" : "text-muted"
                }`}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                className={`h-[2px] flex-1 rounded-full mt-3.5 mx-1 ${
                  done ? "bg-cobalt" : "bg-hairline"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: API key
// ---------------------------------------------------------------------------

function StepKey({ keyValid, t }: { keyValid: boolean; t: (k: string) => string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted leading-relaxed">{t("wizard.key.desc")}</p>
      <ApiKeyField />
      <button
        onClick={() => void openUrl(AI_STUDIO_URL)}
        className="text-[13px] text-cobalt hover:underline self-start"
      >
        {t("wizard.key.getKey")}
      </button>
      {keyValid && (
        <Banner tone="ok" description={t("wizard.key.ready")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: VB-CABLE
// ---------------------------------------------------------------------------

function StepCable({
  cablePresent,
  refreshDevices,
  t,
}: {
  cablePresent: boolean;
  refreshDevices: () => Promise<void>;
  t: (k: string) => string;
}) {
  const [installing, setInstalling] = useState(false);
  const [errKey, setErrKey] = useState<string | null>(null);
  const [showDownloadFallback, setShowDownloadFallback] = useState(false);
  const [showRebootHint, setShowRebootHint] = useState(false);
  const installFinishedAt = useRef<number | null>(null);

  useEffect(() => {
    if (cablePresent) return;
    let cancelled = false;
    const id = setInterval(() => {
      ipc
        .wizardState()
        .then(() => {
          if (!cancelled) void refreshDevices();
        })
        .catch(() => {});
    }, CABLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cablePresent, refreshDevices]);

  useEffect(() => {
    if (cablePresent) {
      setShowRebootHint(false);
      installFinishedAt.current = null;
      return;
    }
    if (installFinishedAt.current == null) return;
    const remaining = REBOOT_HINT_AFTER_MS - (Date.now() - installFinishedAt.current);
    if (remaining <= 0) {
      setShowRebootHint(true);
      return;
    }
    const id = setTimeout(() => setShowRebootHint(true), remaining);
    return () => clearTimeout(id);
  }, [cablePresent, installing]);

  async function handleInstall() {
    setErrKey(null);
    setShowDownloadFallback(false);
    setShowRebootHint(false);
    setInstalling(true);
    try {
      await ipc.wizardInstallCable();
      installFinishedAt.current = Date.now();
      await refreshDevices();
    } catch (e) {
      const msg = String(e);
      setErrKey(installErrorKey(msg));
      if (isDownloadError(msg)) setShowDownloadFallback(true);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted leading-relaxed">{t("wizard.cable.desc")}</p>

      {cablePresent ? (
        <Banner
          tone="ok"
          title={t("wizard.cable.detected")}
          description={t("wizard.cable.detectedDesc")}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <span className="inline-flex items-center self-start h-6 px-2.5 rounded-pill bg-danger/10 text-danger text-[11px] font-medium">
            {t("wizard.cable.notFound")}
          </span>

          <button
            onClick={() => void handleInstall()}
            disabled={installing}
            className="self-start px-4 h-10 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white text-[13px] font-medium disabled:opacity-50 transition-colors inline-flex items-center gap-2"
          >
            {installing ? (
              <>
                <Spinner size="sm" />
                {t("wizard.cable.installing")}
              </>
            ) : (
              t("wizard.cable.installButton")
            )}
          </button>

          {installing && (
            <p className="text-[12px] text-muted">{t("wizard.cable.installingHint")}</p>
          )}

          {errKey && (
            <Banner
              tone="danger"
              description={t(errKey)}
              action={
                showDownloadFallback
                  ? { label: t("wizard.cable.openSite"), onClick: () => void openUrl(CABLE_PAGE_URL) }
                  : undefined
              }
            />
          )}

          {showRebootHint && (
            <Banner tone="warn" description={t("wizard.cable.rebootHint")} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Devices
// ---------------------------------------------------------------------------

function StepDevices({ t }: { t: (k: string) => string }) {
  const settings = useAppStore((s) => s.settings);
  const devices = useAppStore((s) => s.devices);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const refreshDevices = useAppStore((s) => s.refreshDevices);

  if (!settings) return null;

  const inputDevices = devices?.inputs ?? [];
  const outputDevices = devices?.outputs ?? [];
  const micOptions = buildDeviceOptions(inputDevices);
  const outputOptions = buildDeviceOptions(outputDevices);
  const sysDefault = t("settings.audio.systemDefault");

  const outputName =
    settings.outputId == null
      ? null
      : (outputDevices.find((d) => d.id === settings.outputId)?.name ?? null);
  const echoWarning = outputName != null && !looksLikeHeadphones(outputName);

  function deviceSelect(
    value: string | null,
    onChange: (v: string | null) => void,
    label: string,
    options: Array<{ id: string | null; name: string }>
  ) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] text-muted">{label}</label>
        <SelectRoot
          selectedKey={value ?? "__default__"}
          onSelectionChange={(key) =>
            onChange(key === "__default__" ? null : String(key))
          }
          aria-label={label}
          onOpenChange={(open) => {
            if (open) void refreshDevices();
          }}
        >
          <SelectTrigger className="w-full inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border border-hairline bg-surface text-[14px] text-ink hover:border-stone-300 transition-colors">
            <SelectValue className="flex-1 text-left truncate" />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={options} className="max-h-72 overflow-y-auto">
              {(item) => (
                <ListBoxItem
                  key={item.id ?? "__default__"}
                  id={item.id ?? "__default__"}
                  textValue={item.id == null ? sysDefault : item.name}
                >
                  {item.id == null ? sysDefault : item.name}
                </ListBoxItem>
              )}
            </ListBox>
          </SelectPopover>
        </SelectRoot>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted leading-relaxed">{t("wizard.devices.desc")}</p>
      {deviceSelect(
        settings.micId,
        (v) => void patchSettings({ micId: v }),
        t("settings.audio.mic"),
        micOptions
      )}
      {deviceSelect(
        settings.outputId,
        (v) => void patchSettings({ outputId: v }),
        t("settings.audio.output"),
        outputOptions
      )}
      {echoWarning && (
        <Banner
          tone="warn"
          title={t("live.alertEcho")}
          description={t("live.alertEchoDesc")}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Test
// ---------------------------------------------------------------------------

interface StepTestProps {
  settings: NonNullable<ReturnType<typeof useAppStore.getState>["settings"]>;
  liveState: ReturnType<typeof useAppStore.getState>["liveState"];
  transcript: ReturnType<typeof useAppStore.getState>["transcript"];
  startLive: ReturnType<typeof useAppStore.getState>["startLive"];
  stopLive: ReturnType<typeof useAppStore.getState>["stopLive"];
  clearTranscript: ReturnType<typeof useAppStore.getState>["clearTranscript"];
  t: (k: string) => string;
}

function StepTest({
  settings,
  liveState,
  transcript,
  startLive,
  stopLive,
  clearTranscript,
  t,
}: StepTestProps) {
  const phase = liveState?.phase ?? "off";
  const isRunning =
    phase === "running" || phase === "connecting" || phase === "reconnecting";

  useEffect(() => {
    return () => {
      void stopLive();
    };
  }, [stopLive]);

  async function handleStart() {
    clearTranscript();
    await startLive(buildTestConfig(settings));
  }

  function statusLabel(): string {
    if (phase === "running") return t("live.sessionRunning");
    if (phase === "connecting") return t("live.sessionConnecting");
    if (phase === "reconnecting") return t("live.sessionReconnecting");
    return t("live.sessionOff");
  }
  function statusTone(): string {
    if (phase === "running") return "bg-ok/10 text-ok";
    if (phase === "connecting" || phase === "reconnecting")
      return "bg-warn/10 text-[#8a5d0a]";
    return "bg-stone-100 text-muted";
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink leading-relaxed">{t("wizard.test.instruction")}</p>

      <div className="flex items-center gap-3">
        {isRunning ? (
          <button
            onClick={() => void stopLive()}
            className="px-4 h-10 rounded-pill border border-danger/50 text-danger hover:bg-danger/5 text-[13px] font-medium transition-colors"
          >
            {t("wizard.test.stop")}
          </button>
        ) : (
          <button
            onClick={() => void handleStart()}
            className="px-4 h-10 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white text-[13px] font-medium transition-colors"
          >
            {t("wizard.test.start")}
          </button>
        )}
        <span
          className={`inline-flex items-center h-6 px-2.5 rounded-pill text-[11px] font-medium ${statusTone()}`}
        >
          {statusLabel()}
        </span>
      </div>

      <div className="h-48 border border-hairline rounded-card overflow-hidden flex flex-col bg-paper">
        <TranscriptFeed lines={transcript} />
      </div>

      <div className="rounded-card border border-hairline bg-cobalt-tint/40 p-4 flex flex-col gap-1.5">
        <h3 className="text-[13px] font-semibold text-ink">{t("wizard.test.zoomHeading")}</h3>
        <p className="text-[13px] text-muted leading-relaxed">{t("wizard.test.zoomBody")}</p>
        <p className="text-[12px] text-muted">{t("wizard.test.zoomNote")}</p>
      </div>
    </div>
  );
}
