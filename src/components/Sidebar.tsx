import type { ReactNode, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type Screen } from "../stores/app";
import {
  IconWaveform,
  IconMicMessage,
  IconHistory,
  IconGear,
  IconHelp,
  IconCheck,
  IconCross,
} from "./Icons";

type IconComponent = (p: SVGProps<SVGSVGElement> & { size?: number }) => ReactNode;

interface NavItem {
  id: Screen;
  labelKey: string;
  icon: IconComponent;
}

const NAV_ITEMS: NavItem[] = [
  { id: "live", labelKey: "nav.live", icon: IconWaveform },
  { id: "voice", labelKey: "nav.voice", icon: IconMicMessage },
  { id: "history", labelKey: "nav.history", icon: IconHistory },
  { id: "settings", labelKey: "nav.settings", icon: IconGear },
  { id: "help", labelKey: "nav.help", icon: IconHelp },
];

export function Sidebar() {
  const { t } = useTranslation();
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);
  const devices = useAppStore((s) => s.devices);
  const keyStatus = useAppStore((s) => s.keyStatus);

  const cablePresent = devices?.cablePresent ?? false;
  const keyValid = keyStatus?.state === "valid";

  return (
    <nav
      aria-label={t("live.navLabel")}
      className="flex flex-col w-56 shrink-0 bg-paper border-r border-hairline py-4"
    >
      <div className="flex-1 flex flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => {
          const active = screen === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setScreen(item.id)}
              aria-current={active ? "page" : undefined}
              className={[
                "lt-press group flex items-center gap-3 h-10 px-3 rounded-input text-body font-medium w-full text-left",
                active
                  ? "bg-cobalt-tint text-cobalt-deep"
                  : "text-muted hover:bg-surface-2 hover:text-ink",
              ].join(" ")}
            >
              <Icon
                size={18}
                className={active ? "text-cobalt" : "text-muted group-hover:text-ink-2"}
              />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* ---- Bottom status badges + version ---- */}
      <div className="px-3 pt-4 mt-2 border-t border-hairline flex flex-col gap-2">
        <StatusBadge
          label="VB-CABLE"
          ok={cablePresent}
          onClick={() => setScreen("wizard")}
        />
        <StatusBadge
          label={t("settings.sections.apiKey")}
          ok={keyValid}
          onClick={() => setScreen("settings")}
        />
        <span className="font-mono text-code text-muted px-1.5 pt-1">
          v0.3.1
        </span>
      </div>
    </nav>
  );
}

/** Compact pill badge with a colored dot indicator. */
function StatusBadge({
  label,
  ok,
  onClick,
}: {
  label: string;
  ok: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="lt-press group flex items-center gap-2.5 h-8 px-2.5 rounded-input border border-hairline bg-surface text-label text-muted hover:border-hairline-strong hover:text-ink w-full text-left"
    >
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full shrink-0 ${
          ok ? "bg-ok-tint text-ok-deep" : "bg-danger-tint text-danger-deep"
        }`}
      >
        {ok ? <IconCheck size={10} /> : <IconCross size={10} />}
      </span>
      <span className="font-mono truncate flex-1">{label}</span>
    </button>
  );
}
