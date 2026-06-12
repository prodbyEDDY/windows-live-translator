import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Chip,
  Input,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@heroui/react";
import { ipc, type KeyStatus } from "../lib/ipc";
import { useAppStore } from "../stores/app";

interface ApiKeyFieldProps {
  /** Optional callback invoked after the key is confirmed valid. */
  onValid?: () => void;
}

export function ApiKeyField({ onValid }: ApiKeyFieldProps) {
  const { t } = useTranslation();
  const keyStatus = useAppStore((s) => s.keyStatus);
  const setKeyStatus = useAppStore((s) => s.setKeyStatus);
  const setLastError = useAppStore((s) => s.setLastError);

  const [value, setValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSaveCheck() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      const status = await ipc.apiKeySet(trimmed);
      setKeyStatus(status);
      if (status.state === "valid") {
        setValue("");
        onValid?.();
      }
    } catch (e) {
      setLastError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            type={showKey ? "text" : "password"}
            placeholder={t("settings.apiKey.placeholder")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSaveCheck()}
            className="w-full"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => setShowKey((v) => !v)}
          aria-label={showKey ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
        >
          {showKey ? "🙈" : "👁"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onPress={() => void handleSaveCheck()}
          isDisabled={loading || value.trim().length === 0}
        >
          {loading ? <Spinner size="sm" /> : t("settings.apiKey.saveCheck")}
        </Button>
      </div>
      <KeyStatusChip status={keyStatus} />
    </div>
  );
}

/** Pure status chip — extracted so it can be tested independently. */
export function KeyStatusChip({ status }: { status: KeyStatus | null }) {
  const { t } = useTranslation();

  if (!status || status.state === "missing") {
    return (
      <Chip color="default" size="sm">
        {t("settings.apiKey.missing")}
      </Chip>
    );
  }
  if (status.state === "valid") {
    return (
      <Chip color="success" size="sm">
        {t("settings.apiKey.valid")}
      </Chip>
    );
  }
  if (status.state === "invalid") {
    return (
      <Tooltip>
        <TooltipTrigger>
          <Chip color="danger" size="sm">
            {t("settings.apiKey.invalid")}
          </Chip>
        </TooltipTrigger>
        <TooltipContent>{status.reason}</TooltipContent>
      </Tooltip>
    );
  }
  // state === "error"
  const message = status.state === "error" ? status.message : "";
  return (
    <Tooltip>
      <TooltipTrigger>
        <Chip color="warning" size="sm">
          {t("settings.apiKey.error")}
        </Chip>
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}
