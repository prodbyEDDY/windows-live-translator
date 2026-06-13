import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectPopover,
  SelectTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { LANGUAGES, langLabel, langAutonym } from "../lib/languages";
import { canStart } from "../lib/liveStart";
import { WaveformGlyph, IconSwap, IconStopSquare } from "./Icons";

/** Compact language Select pill: mono code prefix (RU / EN) + native autonym. */
function LangPill({
  value,
  onChange,
  ariaLabel,
  tone,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  ariaLabel: string;
  tone: "out" | "in";
  disabled?: boolean;
}) {
  // Direction is read from alignment + the language code, not a second hue.
  // The OUT role gets a faint cobalt code; the IN role stays neutral.
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
      isDisabled={disabled}
    >
      <SelectTrigger
        className={`lt-press group inline-flex items-center gap-2 h-9 pl-2.5 pr-3.5 rounded-pill border bg-surface text-caption font-medium text-ink ${ring}`}
      >
        <span
          className={`font-mono text-label font-semibold leading-none ${codeColor}`}
        >
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

export function Header() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const keyStatus = useAppStore((s) => s.keyStatus);
  const devices = useAppStore((s) => s.devices);
  const liveState = useAppStore((s) => s.liveState);
  const appPid = useAppStore((s) => s.appPid);
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);
  const startLiveSession = useAppStore((s) => s.startLiveSession);
  const stopLiveSession = useAppStore((s) => s.stopLiveSession);
  const setDurationSec = useAppStore((s) => s.setDurationSec);
  const starting = useAppStore((s) => s.starting);

  const phase = liveState?.phase ?? "off";
  const isRunning =
    phase === "running" || phase === "connecting" || phase === "reconnecting";
  const captureMode = settings?.captureMode ?? "system";
  const cablePresent = devices?.cablePresent ?? false;
  const startResult = canStart(keyStatus, captureMode, appPid, cablePresent);

  // Drive the shared session timer from the live phase.
  useEffect(() => {
    if (phase !== "running") {
      if (phase === "off") setDurationSec(0);
      return;
    }
    const id = setInterval(() => setDurationSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase, setDurationSec]);

  function handleSwap() {
    if (!settings) return;
    void patchSettings({ myLang: settings.peerLang, peerLang: settings.myLang });
  }

  return (
    <header className="relative z-20 flex items-center h-14 pr-5 gap-4 bg-surface border-b border-hairline shrink-0">
      {/* Wordmark — fixed-width block aligned to the sidebar edge (224px). The
          spaced display caps are the single deliberate brand treatment. */}
      <div className="flex items-center gap-2.5 shrink-0 w-56 px-5 border-r border-hairline self-stretch">
        <WaveformGlyph active={phase === "running"} />
        <span className="font-display text-caption font-semibold tracking-[0.12em] text-ink leading-none">
          LIVE&nbsp;TRANSLATOR
        </span>
      </div>

      {/* Center: compact language pair */}
      {settings && (
        // The running session keeps the languages it was started with — the
        // setup is sent once per connection and cannot be re-targeted live.
        // Disable the controls so the UI never promises a change it can't make.
        <div
          className="flex-1 flex items-end justify-center gap-3"
          title={isRunning ? t("live.langLockedHint") : undefined}
        >
          {/* "You speak" — your language (outgoing direction). */}
          <div className="flex flex-col items-start gap-1">
            <span className="text-label text-cobalt-deep font-medium px-1 leading-none">
              {t("live.youSpeak")}
            </span>
            <LangPill
              value={settings.myLang}
              onChange={(c) => void patchSettings({ myLang: c })}
              ariaLabel={t("live.youSpeak")}
              tone="out"
              disabled={isRunning}
            />
          </div>
          <button
            onClick={handleSwap}
            disabled={isRunning}
            aria-label={t("live.swapLangs")}
            className="lt-swap mb-0.5 inline-flex items-center justify-center w-8 h-8 rounded-full border border-hairline bg-surface text-muted hover:text-cobalt hover:border-cobalt/40 disabled:opacity-40 disabled:pointer-events-none"
          >
            <IconSwap size={15} />
          </button>
          {/* "Peer speaks" — their language (incoming direction). */}
          <div className="flex flex-col items-start gap-1">
            <span className="text-label text-muted font-medium px-1 leading-none">
              {t("live.peerSpeaks")}
            </span>
            <LangPill
              value={settings.peerLang}
              onChange={(c) => void patchSettings({ peerLang: c })}
              ariaLabel={t("live.peerSpeaks")}
              disabled={isRunning}
              tone="in"
            />
          </div>
        </div>
      )}

      {/* Right: status + start/stop (start/stop only on live screen) */}
      <div className="flex items-center gap-3 shrink-0 w-56 justify-end">
        {/* Compact "session running — open Live" pill: the only global stop/return
            affordance when the user has navigated away from the Live screen. */}
        {isRunning && screen !== "live" && (
          <button
            onClick={() => setScreen("live")}
            className="lt-press inline-flex items-center gap-1.5 h-9 pl-2.5 pr-3 rounded-pill bg-ok-tint text-ok-deep text-label font-medium hover:bg-ok/15"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ok lt-pulse-dot" />
            {t("live.runningPill")}
          </button>
        )}
        <SessionStatusChip phase={phase} t={t} />
        {screen === "live" &&
          (isRunning ? (
            <Button
              variant="outline"
              onPress={() => void stopLiveSession()}
              className="lt-press h-9 px-4 rounded-pill border-danger/50 text-danger hover:bg-danger/5 font-display text-label inline-flex items-center gap-1.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-danger lt-pulse-dot" />
              <IconStopSquare size={14} />
              {t("common.stop")}
            </Button>
          ) : startResult.ok ? (
            <Button
              variant="primary"
              isDisabled={starting}
              onPress={() => void startLiveSession()}
              className="lt-press lt-glow h-9 px-5 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white font-display text-label disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {starting && <Spinner size="sm" />}
              {starting ? t("common.loading") : t("common.start")}
            </Button>
          ) : (
            // Disabled Start: aria-disabled (not the native disabled attr) + a
            // guarded onClick keeps the button in the tab order so the tooltip
            // explaining WHY it's blocked stays keyboard-reachable.
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="outline"
                  aria-disabled
                  onPress={() => {}}
                  className="h-9 px-5 rounded-pill border-hairline text-muted/70 font-display text-label cursor-not-allowed"
                >
                  {t("common.start")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {startResult.reason ? t(startResult.reason) : ""}
              </TooltipContent>
            </Tooltip>
          ))}
      </div>
    </header>
  );
}

function SessionStatusChip({
  phase,
  t,
}: {
  phase: string;
  t: (k: string) => string;
}) {
  let label = t("live.sessionOff");
  let dot = "bg-hairline-strong";
  let text = "text-muted";
  let bg = "bg-surface-2";
  let pulse = false;
  if (phase === "running") {
    label = t("live.sessionRunning");
    dot = "bg-ok";
    text = "text-ok-deep";
    bg = "bg-ok-tint";
  } else if (phase === "connecting" || phase === "reconnecting") {
    label =
      phase === "connecting"
        ? t("live.sessionConnecting")
        : t("live.sessionReconnecting");
    dot = "bg-warn";
    text = "text-warn-deep";
    bg = "bg-warn-tint";
    pulse = true;
  } else if (phase === "error") {
    label = t("live.statusError");
    dot = "bg-danger";
    text = "text-danger-deep";
    bg = "bg-danger-tint";
  }
  return (
    <span
      className={`inline-flex items-center gap-2 h-9 px-3 rounded-pill text-label font-medium ${bg} ${text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${pulse ? "lt-pulse-dot" : ""}`} />
      {label}
    </span>
  );
}
