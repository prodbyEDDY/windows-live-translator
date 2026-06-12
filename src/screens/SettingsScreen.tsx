import { useTranslation } from "react-i18next";

export function SettingsScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 p-6">
      <h1 className="text-xl font-semibold text-gray-800">{t("screen.settings")}</h1>
    </div>
  );
}
