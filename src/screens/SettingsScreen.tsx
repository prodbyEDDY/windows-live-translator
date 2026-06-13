import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
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
import { Banner } from "../components/Banner";
import { SectionTitle } from "../components/ScreenShell";
import { IconCheck, IconCross } from "../components/Icons";
import { ipc, type DeviceInfo } from "../lib/ipc";
import i18next from "../i18n";

// Helper to build device select options (null = system default)
export function buildDeviceOptions(
  devices: DeviceInfo[]
): Array<{ id: string | null; name: string }> {
  return [{ id: null, name: "" }, ...devices.map((d) => ({ id: d.id, name: d.name }))];
}

export function formatDb(v: number): string {
  return v === 0 ? "0 dB" : `${v} dB`;
}

export function formatPercent(v: number): string {
  return `${Math.round(v)}%`;
}

function deviceLabel(
  id: string | null,
  devices: DeviceInfo[],
  defaultLabel: string
): string {
  if (id == null) return defaultLabel;
  return devices.find((d) => d.id === id)?.name ?? defaultLabel;
}

/** Settings surface card with an Unbounded section title. */
function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-surface border border-hairline rounded-card lt-card p-5 flex flex-col gap-4">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

/** Restyled HeroUI Switch — cobalt accent, optional hint. */
function SettingSwitch({
  selected,
  onChange,
  label,
  hint,
  children,
}: {
  selected: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Switch
        isSelected={selected}
        onChange={onChange}
        className="group flex items-center gap-3"
      >
        <SwitchControl className="data-[selected]:bg-cobalt">
          <SwitchThumb />
        </SwitchControl>
        <SwitchContent className="text-[14px] text-ink">{label}</SwitchContent>
      </Switch>
      {hint && <p className="text-[12px] text-muted ml-11">{hint}</p>}
      {children}
    </div>
  );
}

export function DeviceSelect({
  value,
  onChange,
  label,
  options,
  sysDefault,
  onOpen,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
  options: Array<{ id: string | null; name: string }>;
  sysDefault: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  // A saved device id that no longer exists among the live options (e.g. an
  // unplugged USB mic). Fall back to the system-default selection and warn so
  // the user isn't silently routed to a device they didn't pick.
  const missing =
    value != null && !options.some((o) => o.id === value);
  const selectedKey = missing ? "__default__" : (value ?? "__default__");

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] text-muted">{label}</label>
      <SelectRoot
        selectedKey={selectedKey}
        onSelectionChange={(key) =>
          onChange(key === "__default__" ? null : String(key))
        }
        placeholder={deviceLabel(value, options.filter((o) => o.id) as DeviceInfo[], sysDefault)}
        aria-label={label}
        onOpenChange={(open) => {
          if (open) onOpen();
        }}
      >
        <SelectTrigger className="lt-press w-full inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border border-hairline bg-surface text-[14px] text-ink hover:border-stone-300">
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
      {missing && (
        <p className="text-[12px] text-muted">{t("settings.audio.deviceMissing")}</p>
      )}
    </div>
  );
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

  // TTS voice names (single source of truth lives in the backend).
  const [ttsVoices, setTtsVoices] = useState<string[]>([]);
  useEffect(() => {
    ipc.ttsVoices().then(setTtsVoices).catch(() => setTtsVoices([]));
  }, []);

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-muted">{t("common.loading")}</span>
      </div>
    );
  }

  const inputDevices = devices?.inputs ?? [];
  const outputDevices = devices?.outputs ?? [];
  const cablePresent = devices?.cablePresent ?? false;
  const micOptions = buildDeviceOptions(inputDevices);
  const outputOptions = buildDeviceOptions(outputDevices);
  const sysDefault = t("settings.audio.systemDefault");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-[920px] mx-auto px-6 py-6 flex flex-col gap-5 lt-screen-in">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none">
          {t("screen.settings")}
        </h1>

        {lastError && (
          <Banner
            tone="danger"
            title={t("common.error")}
            description={lastError}
            onDismiss={() => setLastError(null)}
          />
        )}

        {/* ---- API key ---- */}
        <SettingsCard title={t("settings.sections.apiKey")}>
          <ApiKeyField />
          <button
            onClick={() => void openUrl("https://aistudio.google.com/apikey")}
            className="text-[13px] text-cobalt hover:underline self-start rounded"
          >
            {t("settings.apiKey.getKey")}
          </button>
        </SettingsCard>

        {/* ---- Audio ---- */}
        <SettingsCard title={t("settings.sections.audio")}>
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

          <div className="flex items-center justify-between border-t border-hairline mt-1 pt-3">
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${
                  cablePresent ? "bg-ok/12 text-ok" : "bg-danger/12 text-danger"
                }`}
              >
                {cablePresent ? <IconCheck size={13} /> : <IconCross size={13} />}
              </span>
              <span className="text-[13px] text-ink">
                VB-CABLE ·{" "}
                <span className="text-muted">
                  {cablePresent
                    ? t("settings.audio.cableInstalled")
                    : t("settings.audio.cableNotFound")}
                </span>
              </span>
            </div>
            <button
              onClick={() => setScreen("wizard")}
              className="lt-press px-3.5 h-9 rounded-pill border border-hairline text-[12px] text-ink hover:border-stone-300"
            >
              {t("settings.audio.wizardButton")}
            </button>
          </div>
        </SettingsCard>

        {/* ---- Translation ---- */}
        <SettingsCard title={t("settings.sections.translation")}>
          <SettingSwitch
            selected={settings.echoTargetLanguage}
            onChange={(c) => void patchSettings({ echoTargetLanguage: c })}
            label={t("settings.translation.echoTargetLanguage")}
            hint={t("settings.translation.echoTargetLanguageHint")}
          />

          <SettingSwitch
            selected={settings.duckingEnabled}
            onChange={(c) => void patchSettings({ duckingEnabled: c })}
            label={t("settings.translation.duckingEnabled")}
          >
            {settings.duckingEnabled && (
              <div className="ml-11 flex flex-col gap-1">
                <label className="text-[13px] text-muted">
                  {t("settings.translation.duckLevel")}: {formatPercent(settings.duckLevel)}
                </label>
                <Slider
                  value={[settings.duckLevel]}
                  onChange={(vals) =>
                    void patchSettings({
                      duckLevel: (Array.isArray(vals) ? vals[0] : vals) as number,
                    })
                  }
                  minValue={0}
                  maxValue={100}
                  step={1}
                  aria-label={t("settings.translation.duckLevel")}
                >
                  <SliderTrack>
                    <SliderFill className="bg-cobalt" />
                    <SliderThumb />
                  </SliderTrack>
                  <SliderOutput />
                </Slider>
              </div>
            )}
          </SettingSwitch>

          <SettingSwitch
            selected={settings.mixOriginal}
            onChange={(c) => void patchSettings({ mixOriginal: c })}
            label={t("settings.translation.mixOriginal")}
          >
            {settings.mixOriginal && (
              <div className="ml-11 flex flex-col gap-1">
                <label className="text-[13px] text-muted">
                  {t("settings.translation.mixGainDb")}: {formatDb(settings.mixGainDb)}
                </label>
                <Slider
                  value={[settings.mixGainDb]}
                  onChange={(vals) =>
                    void patchSettings({
                      mixGainDb: (Array.isArray(vals) ? vals[0] : vals) as number,
                    })
                  }
                  minValue={-24}
                  maxValue={0}
                  step={1}
                  aria-label={t("settings.translation.mixGainDb")}
                >
                  <SliderTrack>
                    <SliderFill className="bg-cobalt" />
                    <SliderThumb />
                  </SliderTrack>
                  <SliderOutput />
                </Slider>
              </div>
            )}
          </SettingSwitch>

          <SettingSwitch
            selected={settings.vadEconomy}
            onChange={(c) => void patchSettings({ vadEconomy: c })}
            label={t("settings.translation.vadEconomy")}
            hint={t("settings.translation.vadEconomyHint")}
          />
        </SettingsCard>

        {/* ---- Voice messages ---- */}
        <SettingsCard title={t("settings.sections.voice")}>
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] text-muted">
              {t("settings.voice.ttsVoice")}
            </label>
            <SelectRoot
              selectedKey={settings.ttsVoice}
              onSelectionChange={(key) =>
                void patchSettings({ ttsVoice: String(key) })
              }
              aria-label={t("settings.voice.ttsVoice")}
            >
              <SelectTrigger className="lt-press w-64 inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border border-hairline bg-surface text-[14px] text-ink hover:border-stone-300">
                <SelectValue className="flex-1 text-left truncate" />
                <SelectIndicator />
              </SelectTrigger>
              <SelectPopover>
                <ListBox
                  items={(ttsVoices.length ? ttsVoices : [settings.ttsVoice]).map(
                    (v) => ({ id: v })
                  )}
                  className="max-h-72 overflow-y-auto"
                >
                  {(item) => (
                    <ListBoxItem key={item.id} id={item.id} textValue={item.id}>
                      {item.id}
                    </ListBoxItem>
                  )}
                </ListBox>
              </SelectPopover>
            </SelectRoot>
            <p className="text-[12px] text-muted">
              {t("settings.voice.ttsVoiceHint")}
            </p>
          </div>
        </SettingsCard>

        {/* ---- App ---- */}
        <SettingsCard title={t("settings.sections.app")}>
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] text-muted">{t("settings.app.uiLang")}</label>
            <SelectRoot
              selectedKey={settings.uiLang}
              onSelectionChange={(key) => {
                const lang = String(key);
                void patchSettings({ uiLang: lang });
                void i18next.changeLanguage(lang);
              }}
              aria-label={t("settings.app.uiLang")}
            >
              <SelectTrigger className="lt-press w-48 inline-flex items-center gap-2 h-10 px-3.5 rounded-[10px] border border-hairline bg-surface text-[14px] text-ink hover:border-stone-300">
                <SelectValue className="flex-1 text-left" />
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

          <p className="text-[12px] text-muted font-mono">
            {t("settings.app.version")}: 0.3.1
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}
