import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  Chip,
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

/** Milliseconds with no cable detection after install before the reboot hint. */
const REBOOT_HINT_AFTER_MS = 30_000;
/** Cable re-poll interval while on the VB-CABLE step. */
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
      <div className="flex-1 p-6 flex items-center justify-center">
        <span className="text-gray-400">{t("common.loading")}</span>
      </div>
    );
  }

  const cablePresent = devices?.cablePresent ?? false;
  const keyValid = keyStatus?.state === "valid";

  // Per-step gating for the "Next" button.
  const canAdvance =
    step === "key"
      ? keyValid
      : step === "cable"
        ? cablePresent
        : true; // devices + test steps are not gated

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

  return (
    <div className="flex-1 flex flex-col items-center p-6 overflow-auto">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <header className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold text-gray-800">
            {t("wizard.title")}
          </h1>
          <StepIndicator current={stepIdx} />
        </header>

        {step === "key" && <StepKey keyValid={keyValid} t={t} />}
        {step === "cable" && (
          <StepCable
            cablePresent={cablePresent}
            refreshDevices={refreshDevices}
            t={t}
          />
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
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            onPress={goBack}
            isDisabled={stepIdx === 0}
          >
            {t("common.back")}
          </Button>

          {step === "test" ? (
            <Button variant="primary" onPress={() => void finish()}>
              {t("wizard.test.allWorks")}
            </Button>
          ) : (
            <Button
              variant="primary"
              onPress={goNext}
              isDisabled={!canAdvance}
            >
              {t("common.next")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator (progress dots + labels)
// ---------------------------------------------------------------------------

function StepIndicator({ current }: { current: number }) {
  const { t } = useTranslation();
  const labels = [
    t("wizard.steps.key"),
    t("wizard.steps.cable"),
    t("wizard.steps.devices"),
    t("wizard.steps.test"),
  ];
  return (
    <div className="flex items-center gap-2">
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={label} className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium flex-shrink-0 ${
                  active
                    ? "bg-blue-500 text-white"
                    : done
                      ? "bg-green-500 text-white"
                      : "bg-gray-200 text-gray-500"
                }`}
              >
                {done ? "✓" : i + 1}
              </div>
              <span
                className={`text-xs truncate ${
                  active ? "text-gray-800 font-medium" : "text-gray-400"
                }`}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                className={`h-0.5 flex-1 rounded ${
                  done ? "bg-green-500" : "bg-gray-200"
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

function StepKey({
  keyValid,
  t,
}: {
  keyValid: boolean;
  t: (k: string) => string;
}) {
  return (
    <Card className="p-5 flex flex-col gap-4">
      <h2 className="text-base font-semibold text-gray-700">
        {t("wizard.key.heading")}
      </h2>
      <p className="text-sm text-gray-500">{t("wizard.key.desc")}</p>
      <ApiKeyField />
      <button
        onClick={() => void openUrl(AI_STUDIO_URL)}
        className="text-sm text-blue-600 hover:underline self-start"
      >
        {t("wizard.key.getKey")}
      </button>
      {keyValid && (
        <Chip color="success" size="sm">
          {t("wizard.key.ready")}
        </Chip>
      )}
    </Card>
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
  // Track whether an install run has completed (we then watch for detection).
  const installFinishedAt = useRef<number | null>(null);

  // Poll wizard_state every 2s while the cable is absent (fallback to the
  // devices:changed event which the store already subscribes to).
  useEffect(() => {
    if (cablePresent) return;
    let cancelled = false;
    const id = setInterval(() => {
      ipc
        .wizardState()
        .then(() => {
          if (!cancelled) void refreshDevices();
        })
        .catch(() => {
          /* transient; next tick retries */
        });
    }, CABLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cablePresent, refreshDevices]);

  // After an install finishes, if the cable still isn't detected within ~30s,
  // surface the "may need a reboot" hint.
  useEffect(() => {
    if (cablePresent) {
      setShowRebootHint(false);
      installFinishedAt.current = null;
      return;
    }
    if (installFinishedAt.current == null) return;
    const remaining =
      REBOOT_HINT_AFTER_MS - (Date.now() - installFinishedAt.current);
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
      // Installer exited cleanly; start the reboot-hint timer and let polling
      // pick up the new endpoint.
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
    <Card className="p-5 flex flex-col gap-4">
      <h2 className="text-base font-semibold text-gray-700">
        {t("wizard.cable.heading")}
      </h2>
      <p className="text-sm text-gray-500">{t("wizard.cable.desc")}</p>

      {cablePresent ? (
        <Alert status="success" className="py-2">
          <AlertTitle className="text-sm">
            {t("wizard.cable.detected")}
          </AlertTitle>
          <AlertDescription className="text-xs">
            {t("wizard.cable.detectedDesc")}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Chip color="danger" size="sm">
              {t("wizard.cable.notFound")}
            </Chip>
          </div>

          <Button
            variant="primary"
            className="self-start"
            onPress={() => void handleInstall()}
            isDisabled={installing}
          >
            {installing ? (
              <span className="flex items-center gap-2">
                <Spinner size="sm" />
                {t("wizard.cable.installing")}
              </span>
            ) : (
              t("wizard.cable.installButton")
            )}
          </Button>

          {installing && (
            <p className="text-xs text-gray-500">
              {t("wizard.cable.installingHint")}
            </p>
          )}

          {errKey && (
            <Alert status="danger" className="py-2 flex flex-col gap-2">
              <AlertDescription className="text-xs">
                {t(errKey)}
              </AlertDescription>
              {showDownloadFallback && (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onPress={() => void openUrl(CABLE_PAGE_URL)}
                >
                  {t("wizard.cable.openSite")}
                </Button>
              )}
            </Alert>
          )}

          {showRebootHint && (
            <Alert status="warning" className="py-2">
              <AlertDescription className="text-xs">
                {t("wizard.cable.rebootHint")}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </Card>
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

  return (
    <Card className="p-5 flex flex-col gap-5">
      <h2 className="text-base font-semibold text-gray-700">
        {t("wizard.devices.heading")}
      </h2>
      <p className="text-sm text-gray-500">{t("wizard.devices.desc")}</p>

      {/* Microphone */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-600">{t("settings.audio.mic")}</label>
        <SelectRoot
          selectedKey={settings.micId ?? "__default__"}
          onSelectionChange={(key) => {
            const val = key === "__default__" ? null : String(key);
            void patchSettings({ micId: val });
          }}
          aria-label={t("settings.audio.mic")}
          onOpenChange={(open) => {
            if (open) void refreshDevices();
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={micOptions}>
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

      {/* Output */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-600">
          {t("settings.audio.output")}
        </label>
        <SelectRoot
          selectedKey={settings.outputId ?? "__default__"}
          onSelectionChange={(key) => {
            const val = key === "__default__" ? null : String(key);
            void patchSettings({ outputId: val });
          }}
          aria-label={t("settings.audio.output")}
          onOpenChange={(open) => {
            if (open) void refreshDevices();
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={outputOptions}>
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

      {echoWarning && (
        <Alert status="warning" className="py-2">
          <AlertTitle className="text-sm">{t("live.alertEcho")}</AlertTitle>
          <AlertDescription className="text-xs">
            {t("live.alertEchoDesc")}
          </AlertDescription>
        </Alert>
      )}
    </Card>
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

  // Tear down any running test session when leaving the step.
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
  function statusColor(): "success" | "warning" | "default" {
    if (phase === "running") return "success";
    if (phase === "connecting" || phase === "reconnecting") return "warning";
    return "default";
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-gray-700">
          {t("wizard.test.heading")}
        </h2>
        <p className="text-sm text-gray-600">{t("wizard.test.instruction")}</p>

        <div className="flex items-center gap-3">
          {isRunning ? (
            <Button variant="danger" onPress={() => void stopLive()}>
              {t("wizard.test.stop")}
            </Button>
          ) : (
            <Button variant="primary" onPress={() => void handleStart()}>
              {t("wizard.test.start")}
            </Button>
          )}
          <Chip color={statusColor()} size="sm">
            {statusLabel()}
          </Chip>
        </div>

        {/* Transcript: user sees their own words + the translation. */}
        <div className="h-48 border border-gray-200 rounded-lg overflow-hidden flex flex-col">
          <TranscriptFeed lines={transcript} />
        </div>
      </Card>

      {/* Zoom / WhatsApp instruction. */}
      <Card className="p-5 flex flex-col gap-2 bg-blue-50/50">
        <h3 className="text-sm font-semibold text-gray-700">
          {t("wizard.test.zoomHeading")}
        </h3>
        <p className="text-sm text-gray-600">{t("wizard.test.zoomBody")}</p>
        <p className="text-xs text-gray-500">{t("wizard.test.zoomNote")}</p>
      </Card>
    </div>
  );
}
