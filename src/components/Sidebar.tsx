import { useTranslation } from "react-i18next";
import { useAppStore, type Screen } from "../stores/app";

interface NavItem {
  id: Screen;
  labelKey: string;
  icon: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "live", labelKey: "nav.live", icon: "🎙" },
  { id: "voice", labelKey: "nav.voice", icon: "🗣" },
  { id: "history", labelKey: "nav.history", icon: "📋" },
  { id: "settings", labelKey: "nav.settings", icon: "⚙" },
];

export function Sidebar() {
  const { t } = useTranslation();
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);

  return (
    <nav className="flex flex-col w-48 min-h-screen bg-white border-r border-gray-100 py-4 px-2 gap-1">
      <div className="px-3 py-2 mb-2">
        <span className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          {t("app.title")}
        </span>
      </div>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => setScreen(item.id)}
          className={[
            "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full text-left",
            screen === item.id
              ? "bg-blue-50 text-blue-700"
              : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
          ].join(" ")}
        >
          <span className="text-base leading-none">{item.icon}</span>
          <span>{t(item.labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}
