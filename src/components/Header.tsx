import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { canStart } from "../lib/liveStart";
import { WaveformGlyph, IconStopSquare } from "./Icons";

export function Header() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
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

      {/* The language pair + per-mode setup now live in each page's body; the
          header is pure global chrome (brand · session status · start/stop). */}
      <div className="flex-1" />

      {/* Right: status + start/stop (start/stop only on the Live screen) */}
      <div className="flex items-center gap-3 shrink-0 justify-end">
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
