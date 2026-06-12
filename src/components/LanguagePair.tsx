import { useTranslation } from "react-i18next";
import {
  Button,
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectIndicator,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@heroui/react";
import { useAppStore } from "../stores/app";
import { LANGUAGES } from "../lib/languages";

export function LanguagePair() {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);

  if (!settings) return null;

  const myLang = settings.myLang;
  const peerLang = settings.peerLang;

  function handleSwap() {
    void patchSettings({ myLang: peerLang, peerLang: myLang });
  }

  return (
    <div className="flex items-center gap-2">
      {/* My language */}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <label className="text-xs text-gray-500">{t("live.myLang")}</label>
        <SelectRoot
          selectedKey={myLang}
          onSelectionChange={(key) => void patchSettings({ myLang: String(key) })}
          aria-label={t("live.myLang")}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={LANGUAGES}>
              {(lang) => (
                <ListBoxItem
                  key={lang.code}
                  id={lang.code}
                  textValue={lang.autonym}
                >
                  {lang.autonym}
                </ListBoxItem>
              )}
            </ListBox>
          </SelectPopover>
        </SelectRoot>
      </div>

      {/* Swap button */}
      <Button
        variant="ghost"
        size="sm"
        className="mt-4 flex-shrink-0"
        onPress={handleSwap}
        aria-label={t("live.swapLangs")}
      >
        ⇄
      </Button>

      {/* Peer language */}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <label className="text-xs text-gray-500">{t("live.peerLang")}</label>
        <SelectRoot
          selectedKey={peerLang}
          onSelectionChange={(key) => void patchSettings({ peerLang: String(key) })}
          aria-label={t("live.peerLang")}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
            <SelectIndicator />
          </SelectTrigger>
          <SelectPopover>
            <ListBox items={LANGUAGES}>
              {(lang) => (
                <ListBoxItem
                  key={lang.code}
                  id={lang.code}
                  textValue={lang.autonym}
                >
                  {lang.autonym}
                </ListBoxItem>
              )}
            </ListBox>
          </SelectPopover>
        </SelectRoot>
      </div>
    </div>
  );
}
