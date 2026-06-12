import { useTranslation } from "react-i18next";

export function VoiceScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 p-6">
      <h1 className="text-xl font-semibold text-gray-800">{t("screen.voice")}</h1>
    </div>
  );
}
