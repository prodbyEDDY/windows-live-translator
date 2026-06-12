import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectPopover,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { LANGUAGES } from "../lib/languages";
import { canStart } from "../lib/liveStart";
import { WaveformGlyph, IconSwap, IconStopSquare } from "./Icons";

/** Compact language Select pill used in the header (no label). */
function LangPill({
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
      ? "border-cobalt/30 text-cobalt-deep hover:border-cobalt/60"
      : "border-tangerine/30 text-tangerine-deep hover:border-tangerine/60";
  return (
    <SelectRoot
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      aria-label={ariaLabel}
    >
      <SelectTrigger
        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-pill border bg-surface text-[13px] font-medium transition-colors ${ring}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopover>
        <ListBox items={LANGUAGES} className="max-h-72 overflow-y-auto">
          {(lang) => (
            <ListBoxItem key={lang.code} id={lang.code} textValue={lang.autonym}>
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
  const startLiveSession = useAppStore((s) => s.startLiveSession);
  const stopLiveSession = useAppStore((s) => s.stopLiveSession);
  const setDurationSec = useAppStore((s) => s.setDurationSec);

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
    <header className="relative z-20 flex items-center h-14 px-4 gap-4 bg-surface border-b border-hairline shadow-[0_1px_2px_rgb(28_25_23_/_0.05)] shrink-0">
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 shrink-0 w-52">
        <WaveformGlyph active={phase === "running"} />
        <span className="font-display text-[13px] font-semibold tracking-[0.14em] text-ink leading-none">
          LIVE&nbsp;TRANSLATOR
        </span>
      </div>

      {/* Center: compact language pair */}
      {settings && (
        <div className="flex-1 flex items-center justify-center gap-2">
          <LangPill
            value={settings.myLang}
            onChange={(c) => void patchSettings({ myLang: c })}
            ariaLabel={t("live.myLang")}
            tone="out"
          />
          <button
            onClick={handleSwap}
            aria-label={t("live.swapLangs")}
            className="lt-swap inline-flex items-center justify-center w-8 h-8 rounded-pill border border-hairline bg-surface text-muted hover:text-ink hover:border-stone-300 transition-all active:rotate-180 active:duration-200"
          >
            <IconSwap size={16} />
          </button>
          <LangPill
            value={settings.peerLang}
            onChange={(c) => void patchSettings({ peerLang: c })}
            ariaLabel={t("live.peerLang")}
            tone="in"
          />
        </div>
      )}

      {/* Right: status + start/stop (start/stop only on live screen) */}
      <div className="flex items-center gap-3 shrink-0 w-52 justify-end">
        <SessionStatusChip phase={phase} t={t} />
        {screen === "live" &&
          (isRunning ? (
            <Button
              variant="outline"
              onPress={() => void stopLiveSession()}
              className="h-9 px-4 rounded-pill border-danger/50 text-danger hover:bg-danger/5 font-display text-[12px] tracking-wide inline-flex items-center gap-1.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-danger lt-pulse-dot" />
              <IconStopSquare size={14} />
              {t("common.stop")}
            </Button>
          ) : startResult.ok ? (
            <Button
              variant="primary"
              onPress={() => void startLiveSession()}
              className="h-9 px-5 rounded-pill bg-cobalt hover:bg-cobalt-deep text-white font-display text-[12px] tracking-wide"
            >
              {t("common.start")}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="outline"
                  isDisabled
                  className="h-9 px-5 rounded-pill border-hairline text-stone-400 font-display text-[12px] tracking-wide"
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
  let dot = "bg-stone-300";
  let text = "text-muted";
  let bg = "bg-stone-100";
  let pulse = false;
  if (phase === "running") {
    label = t("live.sessionRunning");
    dot = "bg-ok";
    text = "text-ok";
    bg = "bg-[#177e5b]/8";
  } else if (phase === "connecting" || phase === "reconnecting") {
    label =
      phase === "connecting"
        ? t("live.sessionConnecting")
        : t("live.sessionReconnecting");
    dot = "bg-warn";
    text = "text-warn";
    bg = "bg-[#b97d10]/8";
    pulse = true;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-pill text-[11px] font-medium ${bg} ${text}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${pulse ? "lt-pulse-dot" : ""}`} />
      {label}
    </span>
  );
}
