import type { ReactNode, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type Screen } from "../stores/app";
import {
  IconWaveform,
  IconMicMessage,
  IconHistory,
  IconGear,
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
    <nav className="flex flex-col w-56 shrink-0 bg-paper border-r border-hairline py-3">
      <div className="flex-1 flex flex-col gap-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const active = screen === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setScreen(item.id)}
              aria-current={active ? "page" : undefined}
              className={[
                "lt-press group relative flex items-center gap-3 h-10 px-3 rounded-lg text-[14px] font-medium w-full text-left",
                active
                  ? "bg-cobalt-tint text-cobalt-deep"
                  : "text-muted hover:bg-stone-100 hover:text-ink",
              ].join(" ")}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-cobalt" />
              )}
              <Icon size={18} className={active ? "text-cobalt" : undefined} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* ---- Bottom status badges + version ---- */}
      <div className="px-3 pt-3 mt-2 border-t border-hairline flex flex-col gap-1.5">
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
        <span className="font-mono text-[10px] text-stone-400 tracking-tight px-1.5 pt-1.5">
          v0.3.0
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
      className="lt-press group flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-lg border border-hairline bg-surface text-[12px] text-muted hover:border-stone-300 hover:text-ink w-full text-left"
    >
      <span
        className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full shrink-0 ${
          ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"
        }`}
      >
        {ok ? <IconCheck size={9} /> : <IconCross size={9} />}
      </span>
      <span className="font-mono tracking-tight truncate flex-1">{label}</span>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-ok" : "bg-danger"}`}
      />
    </button>
  );
}
