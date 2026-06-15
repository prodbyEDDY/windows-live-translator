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
  Spinner,
  Switch,
  SwitchContent,
  SwitchControl,
  SwitchThumb,
} from "@heroui/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/app";
import { ApiKeyField, KeyStatusChip } from "../components/ApiKeyField";
import { Banner } from "../components/Banner";
import { IconCheck, IconCross, IconEye, IconEyeOff } from "../components/Icons";
import { ipc, type DeviceInfo, type KeyStatus } from "../lib/ipc";
import { isLoopbackCaptureDevice } from "../lib/echo";
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

/** Shared trigger styling for every select on this screen. */
const SELECT_TRIGGER =
  "lt-press inline-flex items-center gap-2 h-11 px-3.5 rounded-input border border-hairline bg-surface text-body text-ink hover:border-hairline-strong";

/**
 * A settings group: a spacious surface card with a quiet sentence-case title
 * and an optional one-line description. No uppercase eyebrow, no side rule.
 */
function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border border-hairline rounded-card lt-card p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-emphasis font-semibold tracking-tight text-ink leading-snug">
          {title}
        </h2>
        {description && (
          <p className="text-caption text-muted leading-snug max-w-prose">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** A labelled field row — quiet sentence-case label above its control. */
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-caption text-ink-2">{label}</label>
      {children}
      {hint && <p className="text-label text-muted leading-snug max-w-prose">{hint}</p>}
    </div>
  );
}

/** Restyled HeroUI Switch — cobalt accent, optional hint + disclosed children. */
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
    <div className="flex flex-col gap-2.5">
      <Switch
        isSelected={selected}
        onChange={onChange}
        className="group flex items-center gap-3"
      >
        <SwitchControl className="data-[selected]:bg-cobalt">
          <SwitchThumb />
        </SwitchControl>
        <SwitchContent className="text-body text-ink">{label}</SwitchContent>
      </Switch>
      {hint && <p className="text-label text-muted leading-snug ml-11 max-w-prose">{hint}</p>}
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
    <Field
      label={label}
      hint={missing ? t("settings.audio.deviceMissing") : undefined}
    >
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
        <SelectTrigger className={`${SELECT_TRIGGER} w-full`}>
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
    </Field>
  );
}

/**
 * ElevenLabs credential field: a password key input + a voice-id text input + a
 * single "Save & check" that validates both against get-voice (one call proves
 * the key AND the voice id), then stores the key in the OS keyring and the voice
 * id in settings. An empty key reuses the stored one, so the voice id can be
 * changed without re-typing the key. Mirrors {@link ApiKeyField}.
 */
function ElevenLabsField() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const setLastError = useAppStore((s) => s.setLastError);

  const [key, setKey] = useState("");
  const [voiceId, setVoiceId] = useState(settings?.elevenVoiceId ?? "");
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loading, setLoading] = useState(false);

  // Reflect a previously-stored key on mount (optimistic, like the Gemini chip),
  // so reopening Settings shows the key is saved without a re-check.
  useEffect(() => {
    ipc
      .elevenlabsStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  async function handleSaveCheck() {
    const vid = voiceId.trim();
    if (!vid) return;
    setLoading(true);
    try {
      const st = await ipc.elevenlabsKeySet(key.trim() || null, vid);
      setStatus(st);
      if (st.state === "valid") {
        setKey("");
        // Reflect the saved voice id in the store immediately so the provider
        // toggle's "configured" gating updates without a reload (the backend
        // already persisted it).
        await patchSettings({ elevenVoiceId: vid });
      }
    } catch (e) {
      setLastError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <input
          type={showKey ? "text" : "password"}
          placeholder={t("settings.voiceClone.keyPlaceholder")}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="w-full h-11 pl-3.5 pr-10 rounded-input border border-hairline bg-surface text-body text-ink placeholder:text-muted hover:border-hairline-strong focus:border-cobalt outline-none transition-colors font-mono"
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
          aria-pressed={showKey}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors rounded"
        >
          {showKey ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="text"
          placeholder={t("settings.voiceClone.voiceIdPlaceholder")}
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSaveCheck()}
          className="flex-1 min-w-56 h-11 px-3.5 rounded-input border border-hairline bg-surface text-body text-ink placeholder:text-muted hover:border-hairline-strong focus:border-cobalt outline-none transition-colors font-mono"
        />
        <button
          onClick={() => void handleSaveCheck()}
          disabled={loading || voiceId.trim().length === 0}
          className="lt-press shrink-0 h-11 px-5 rounded-pill bg-cobalt hover:bg-cobalt-deep disabled:opacity-40 disabled:hover:bg-cobalt text-white text-caption font-medium inline-flex items-center justify-center min-w-24"
        >
          {loading ? <Spinner size="sm" /> : t("settings.voiceClone.saveCheck")}
        </button>
        <KeyStatusChip status={status} />
      </div>
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
  // Hide render-loopback / monitor endpoints ("CABLE Output", "Stereo Mix", …):
  // picking one as the mic makes the OUT session capture the call audio and
  // translate the peer straight back to themselves.
  const micOptions = buildDeviceOptions(
    inputDevices.filter((d) => !isLoopbackCaptureDevice(d.name))
  );
  const outputOptions = buildDeviceOptions(outputDevices);
  const sysDefault = t("settings.audio.systemDefault");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-[760px] mx-auto px-6 py-8 flex flex-col gap-6 lt-screen-in">
        <h1 className="font-display text-h1 font-semibold tracking-tight text-ink leading-none">
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
        <SettingsCard
          title={t("settings.sections.apiKey")}
          description={t("settings.apiKey.sectionDesc")}
        >
          <ApiKeyField />
          <button
            onClick={() => void openUrl("https://aistudio.google.com/apikey")}
            className="text-caption text-cobalt hover:text-cobalt-deep hover:underline self-start rounded"
          >
            {t("settings.apiKey.getKey")}
          </button>
        </SettingsCard>

        {/* ---- Cloned voice (ElevenLabs) ---- */}
        <SettingsCard
          title={t("settings.sections.voiceClone")}
          description={t("settings.voiceClone.sectionDesc")}
        >
          <ElevenLabsField />
          <SettingSwitch
            selected={settings.ttsProvider === "elevenlabs"}
            onChange={(c) =>
              void patchSettings({ ttsProvider: c ? "elevenlabs" : "gemini" })
            }
            label={t("settings.voiceClone.useClone")}
            hint={
              settings.elevenVoiceId
                ? t("settings.voiceClone.useCloneHint")
                : t("settings.voiceClone.needConfig")
            }
          />
          <button
            onClick={() =>
              void openUrl(
                "https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning"
              )
            }
            className="text-caption text-cobalt hover:text-cobalt-deep hover:underline self-start rounded"
          >
            {t("settings.voiceClone.getVoiceId")}
          </button>
        </SettingsCard>

        {/* ---- Audio ---- */}
        <SettingsCard
          title={t("settings.sections.audio")}
          description={t("settings.audio.sectionDesc")}
        >
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

          <div className="flex items-center justify-between gap-4 border-t border-hairline pt-4">
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className={`inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${
                  cablePresent ? "bg-ok-tint text-ok-deep" : "bg-danger-tint text-danger-deep"
                }`}
              >
                {cablePresent ? <IconCheck size={13} /> : <IconCross size={13} />}
              </span>
              <span className="text-caption text-ink truncate">
                VB-CABLE{" "}
                <span className="text-muted">
                  {cablePresent
                    ? t("settings.audio.cableInstalled")
                    : t("settings.audio.cableNotFound")}
                </span>
              </span>
            </div>
            <button
              onClick={() => setScreen("wizard")}
              className="lt-press shrink-0 px-3.5 h-9 rounded-pill border border-hairline text-label text-ink hover:border-hairline-strong"
            >
              {t("settings.audio.wizardButton")}
            </button>
          </div>

          <div className="border-t border-hairline pt-4">
            <SettingSwitch
              selected={settings.idlePassthrough}
              onChange={(c) => void patchSettings({ idlePassthrough: c })}
              label={t("settings.audio.idlePassthrough")}
              hint={t("settings.audio.idlePassthroughHint")}
            />
          </div>
        </SettingsCard>

        {/* ---- Translation ---- */}
        <SettingsCard
          title={t("settings.sections.translation")}
          description={t("settings.translation.sectionDesc")}
        >
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
            hint={t("settings.translation.duckingEnabledHint")}
          >
            {settings.duckingEnabled && (
              <div className="ml-11 flex flex-col gap-1.5">
                <label className="text-label text-muted">
                  {t("settings.translation.duckLevel")}:{" "}
                  {formatPercent(settings.duckLevel * 100)}
                </label>
                <Slider
                  /* duckLevel is stored 0..1 (the backend's absolute gain); the
                     slider works in whole percent, so scale on the way in/out.
                     Previously the raw 0..1 value was fed to a 0..100 slider and
                     the percent showed "0.2%" while any adjustment sent 0..100
                     (clamped to 1.0 = no ducking). */
                  value={[settings.duckLevel * 100]}
                  onChange={(vals) =>
                    void patchSettings({
                      duckLevel:
                        ((Array.isArray(vals) ? vals[0] : vals) as number) / 100,
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
            hint={t("settings.translation.mixOriginalHint")}
          >
            {settings.mixOriginal && (
              <div className="ml-11 flex flex-col gap-1.5">
                <label className="text-label text-muted">
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

          <SettingSwitch
            selected={settings.idleAutoStop}
            onChange={(c) => void patchSettings({ idleAutoStop: c })}
            label={t("settings.translation.idleAutoStop")}
            hint={t("settings.translation.idleAutoStopHint")}
          />
        </SettingsCard>

        {/* ---- App ---- */}
        <SettingsCard title={t("settings.sections.app")}>
          <Field label={t("settings.app.uiLang")}>
            <SelectRoot
              selectedKey={settings.uiLang}
              onSelectionChange={(key) => {
                const lang = String(key);
                void patchSettings({ uiLang: lang });
                void i18next.changeLanguage(lang);
              }}
              aria-label={t("settings.app.uiLang")}
            >
              <SelectTrigger className={`${SELECT_TRIGGER} w-48`}>
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
          </Field>

          <p className="text-label text-muted font-mono">
            {t("settings.app.version")} 0.3.1
          </p>
        </SettingsCard>
      </div>
    </div>
  );
}
