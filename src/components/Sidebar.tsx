import type { ReactNode } from "react";
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

interface NavItem {
  id: Screen;
  labelKey: string;
  icon: (p: { size?: number }) => ReactNode;
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
      <div className="flex-1 flex flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => {
          const active = screen === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setScreen(item.id)}
              className={[
                "group relative flex items-center gap-3 h-10 pl-3 pr-3 rounded-[10px] text-[14px] font-medium transition-colors w-full text-left",
                active
                  ? "bg-cobalt-tint text-ink"
                  : "text-muted hover:bg-stone-100 hover:text-ink",
              ].join(" ")}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full bg-cobalt" />
              )}
              <Icon size={19} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* ---- Bottom status rows ---- */}
      <div className="px-3 pt-3 mt-2 border-t border-hairline flex flex-col gap-1">
        <StatusRow
          label="VB-CABLE"
          ok={cablePresent}
          onClick={() => setScreen("wizard")}
        />
        <StatusRow
          label={t("settings.sections.apiKey")}
          ok={keyValid}
          onClick={() => setScreen("settings")}
        />
      </div>
    </nav>
  );
}

function StatusRow({
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
      className="flex items-center gap-2 h-8 px-2 rounded-md text-[12px] text-muted hover:bg-stone-100 transition-colors w-full text-left"
    >
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${
          ok ? "bg-ok/12 text-ok" : "bg-danger/12 text-danger"
        }`}
      >
        {ok ? <IconCheck size={11} /> : <IconCross size={11} />}
      </span>
      <span className="font-mono tracking-tight truncate">{label}</span>
    </button>
  );
}
