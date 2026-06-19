import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "./stores/app";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { LiveScreen } from "./screens/LiveScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { VoiceScreen } from "./screens/VoiceScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { HelpScreen } from "./screens/HelpScreen";
import { LogsScreen } from "./screens/LogsScreen";
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
      case "logs":
        return <LogsScreen />;
      case "settings":
        return <SettingsScreen />;
      case "help":
        return <HelpScreen />;
      // "wizard" is handled by the early return below (full-window, no chrome).
    }
  }

  // The wizard is a focused, full-window flow — no app chrome.
  if (screen === "wizard") {
    return (
      <div className="relative h-screen w-screen bg-paper overflow-hidden">
        <title>{t("app.title")}</title>
        <WizardScreen />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-paper text-ink">
      <title>{t("app.title")}</title>
      <Header />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="relative flex-1 min-w-0 flex flex-col bg-paper overflow-hidden">
          <div className="relative z-10 flex-1 min-h-0 flex flex-col">
            {renderScreen()}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
