import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "./stores/app";
import { Sidebar } from "./components/Sidebar";
import { LiveScreen } from "./screens/LiveScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { VoiceScreen } from "./screens/VoiceScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WizardScreen } from "./screens/WizardScreen";

function App() {
  const { t } = useTranslation();
  const init = useAppStore((s) => s.init);
  const settings = useAppStore((s) => s.settings);
  const screen = useAppStore((s) => s.screen);
  const setScreen = useAppStore((s) => s.setScreen);

  useEffect(() => {
    init();
  }, [init]);

  // Force wizard screen until setup is done
  useEffect(() => {
    if (settings && !settings.wizardDone) {
      setScreen("wizard");
    }
  }, [settings, setScreen]);

  function renderScreen() {
    switch (screen) {
      case "live":
        return <LiveScreen />;
      case "voice":
        return <VoiceScreen />;
      case "history":
        return <HistoryScreen />;
      case "settings":
        return <SettingsScreen />;
      case "wizard":
        return <WizardScreen />;
    }
  }

  return (
    <div className="flex flex-row min-h-screen bg-gray-50">
      <title>{t("app.title")}</title>
      {screen !== "wizard" && <Sidebar />}
      <main className="flex flex-1 overflow-auto">
        {renderScreen()}
      </main>
    </div>
  );
}

export default App;
