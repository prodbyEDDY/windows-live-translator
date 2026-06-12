import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertTitle,
  AlertDescription,
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
  Slider,
  SliderFill,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Switch,
  SwitchContent,
  SwitchControl,
  SwitchThumb,
} from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/app";
import { ApiKeyField } from "../components/ApiKeyField";
import type { DeviceInfo } from "../lib/ipc";
import i18next from "../i18n";

// Helper to build device select options (null = system default)
export function buildDeviceOptions(
  devices: DeviceInfo[]
): Array<{ id: string | null; name: string }> {
  return [{ id: null, name: "" }, ...devices.map((d) => ({ id: d.id, name: d.name }))];
}

// Helper to format dB
export function formatDb(v: number): string {
  return v === 0 ? "0 dB" : `${v} dB`;
}

// Helper to format percent
export function formatPercent(v: number): string {
  return `${Math.round(v)}%`;
}

/** Returns the display name for the currently selected device id */
function deviceLabel(
  id: string | null,
  devices: DeviceInfo[],
  defaultLabel: string
): string {
  if (id == null) return defaultLabel;
  return devices.find((d) => d.id === id)?.name ?? defaultLabel;
}

export function SettingsScreen() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const devices = useAppStore((s) => s.devices);
  const lastError = useAppStore((s) => s.lastError);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const setLastError = useAppStore((s) => s.setLastError);
  const refreshDevices = useAppStore((s) => s.refreshDevices);
  const setScreen = useAppStore((s) => s.setScreen);

  if (!settings) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <span className="text-gray-400">{t("common.loading")}</span>
      </div>
    );
  }

  const inputDevices = devices?.inputs ?? [];
  const outputDevices = devices?.outputs ?? [];
  const cablePresent = devices?.cablePresent ?? false;

  const micOptions = buildDeviceOptions(inputDevices);
  const outputOptions = buildDeviceOptions(outputDevices);
  const sysDefault = t("settings.audio.systemDefault");

  function handleOpenAiStudio() {
    void openUrl("https://aistudio.google.com/apikey");
  }

  return (
    <div className="flex-1 p-6 flex flex-col gap-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-gray-800">{t("screen.settings")}</h1>

      {/* Dismissible error alert */}
      {lastError && (
        <Alert status="danger" className="flex items-start gap-3">
          <div className="flex-1">
            <AlertTitle>{t("common.error")}</AlertTitle>
            <AlertDescription className="text-sm">{lastError}</AlertDescription>
          </div>
          <button
            onClick={() => setLastError(null)}
            className="text-gray-400 hover:text-gray-600 ml-2 flex-shrink-0"
            aria-label={t("common.cancel")}
          >
            ✕
          </button>
        </Alert>
      )}

      {/* ---- Section 1: API key ---- */}
      <Card className="p-5 flex flex-col gap-4">
        <h2 className="text-base font-semibold text-gray-700">{t("settings.sections.apiKey")}</h2>
        <ApiKeyField />
        <button
          onClick={handleOpenAiStudio}
          className="text-sm text-blue-600 hover:underline self-start"
        >
          {t("settings.apiKey.getKey")}
        </button>
      </Card>

      {/* ---- Section 2: Audio ---- */}
      <Card className="p-5 flex flex-col gap-5">
        <h2 className="text-base font-semibold text-gray-700">{t("settings.sections.audio")}</h2>

        {/* Microphone */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-600">{t("settings.audio.mic")}</label>
          <SelectRoot
            selectedKey={settings.micId ?? "__default__"}
            onSelectionChange={(key) => {
              const val = key === "__default__" ? null : String(key);
              void patchSettings({ micId: val });
            }}
            placeholder={deviceLabel(settings.micId, inputDevices, sysDefault)}
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
          <label className="text-sm text-gray-600">{t("settings.audio.output")}</label>
          <SelectRoot
            selectedKey={settings.outputId ?? "__default__"}
            onSelectionChange={(key) => {
              const val = key === "__default__" ? null : String(key);
              void patchSettings({ outputId: val });
            }}
            placeholder={deviceLabel(settings.outputId, outputDevices, sysDefault)}
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

        {/* VB-CABLE status */}
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-gray-600">VB-CABLE</span>
            <Chip color={cablePresent ? "success" : "danger"} size="sm">
              {cablePresent
                ? t("settings.audio.cableInstalled")
                : t("settings.audio.cableNotFound")}
            </Chip>
          </div>
          <Button
            variant="outline"
            size="sm"
            onPress={() => setScreen("wizard")}
          >
            {t("settings.audio.wizardButton")}
          </Button>
        </div>
      </Card>

      {/* ---- Section 3: Translation ---- */}
      <Card className="p-5 flex flex-col gap-5">
        <h2 className="text-base font-semibold text-gray-700">
          {t("settings.sections.translation")}
        </h2>

        {/* Echo target language */}
        <div className="flex flex-col gap-1">
          <Switch
            isSelected={settings.echoTargetLanguage}
            onChange={(checked) => void patchSettings({ echoTargetLanguage: checked })}
          >
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
            <SwitchContent>{t("settings.translation.echoTargetLanguage")}</SwitchContent>
          </Switch>
          <p className="text-xs text-gray-500 ml-11">
            {t("settings.translation.echoTargetLanguageHint")}
          </p>
        </div>

        {/* Ducking */}
        <div className="flex flex-col gap-3">
          <Switch
            isSelected={settings.duckingEnabled}
            onChange={(checked) => void patchSettings({ duckingEnabled: checked })}
          >
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
            <SwitchContent>{t("settings.translation.duckingEnabled")}</SwitchContent>
          </Switch>
          {settings.duckingEnabled && (
            <div className="ml-11 flex flex-col gap-1">
              <label className="text-sm text-gray-600">
                {t("settings.translation.duckLevel")}:{" "}
                {formatPercent(settings.duckLevel)}
              </label>
              <Slider
                value={[settings.duckLevel]}
                onChange={(vals) => {
                  const v = Array.isArray(vals) ? vals[0] : vals;
                  void patchSettings({ duckLevel: v as number });
                }}
                minValue={0}
                maxValue={100}
                step={1}
                aria-label={t("settings.translation.duckLevel")}
              >
                <SliderTrack>
                  <SliderFill />
                  <SliderThumb />
                </SliderTrack>
                <SliderOutput />
              </Slider>
            </div>
          )}
        </div>

        {/* Mix original voice under the translation */}
        <div className="flex flex-col gap-3">
          <Switch
            isSelected={settings.mixOriginal}
            onChange={(checked) => void patchSettings({ mixOriginal: checked })}
          >
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
            <SwitchContent>{t("settings.translation.mixOriginal")}</SwitchContent>
          </Switch>
          {settings.mixOriginal && (
            <div className="ml-11 flex flex-col gap-1">
              <label className="text-sm text-gray-600">
                {t("settings.translation.mixGainDb")}: {formatDb(settings.mixGainDb)}
              </label>
              <Slider
                value={[settings.mixGainDb]}
                onChange={(vals) => {
                  const v = Array.isArray(vals) ? vals[0] : vals;
                  void patchSettings({ mixGainDb: v as number });
                }}
                minValue={-24}
                maxValue={0}
                step={1}
                aria-label={t("settings.translation.mixGainDb")}
              >
                <SliderTrack>
                  <SliderFill />
                  <SliderThumb />
                </SliderTrack>
                <SliderOutput />
              </Slider>
            </div>
          )}
        </div>

        {/* VAD economy: pause streaming on silence */}
        <div className="flex flex-col gap-1">
          <Switch
            isSelected={settings.vadEconomy}
            onChange={(checked) => void patchSettings({ vadEconomy: checked })}
          >
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
            <SwitchContent>{t("settings.translation.vadEconomy")}</SwitchContent>
          </Switch>
          <p className="text-xs text-gray-500 ml-11">
            {t("settings.translation.vadEconomyHint")}
          </p>
        </div>
      </Card>

      {/* ---- Section 4: App ---- */}
      <Card className="p-5 flex flex-col gap-5">
        <h2 className="text-base font-semibold text-gray-700">{t("settings.sections.app")}</h2>

        {/* UI language */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-600">{t("settings.app.uiLang")}</label>
          <SelectRoot
            selectedKey={settings.uiLang}
            onSelectionChange={(key) => {
              const lang = String(key);
              void patchSettings({ uiLang: lang });
              void i18next.changeLanguage(lang);
            }}
            aria-label={t("settings.app.uiLang")}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
              <SelectIndicator />
            </SelectTrigger>
            <SelectPopover>
              <ListBox>
                <ListBoxItem id="ru" textValue="Русский">
                  Русский
                </ListBoxItem>
                <ListBoxItem id="en" textValue="English">
                  English
                </ListBoxItem>
              </ListBox>
            </SelectPopover>
          </SelectRoot>
        </div>

        {/* Version */}
        <p className="text-xs text-gray-400">
          {t("settings.app.version")}: 0.1.0
        </p>
      </Card>
    </div>
  );
}
