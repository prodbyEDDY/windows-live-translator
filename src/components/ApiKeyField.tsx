import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner, Tooltip, TooltipContent, TooltipTrigger } from "@heroui/react";
import { ipc, type KeyStatus } from "../lib/ipc";
import { useAppStore } from "../stores/app";
import { IconEye, IconEyeOff } from "./Icons";

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
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative flex-1 min-w-56">
        <input
          type={showKey ? "text" : "password"}
          placeholder={t("settings.apiKey.placeholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSaveCheck()}
          className="w-full h-11 pl-3.5 pr-10 rounded-input border border-hairline bg-surface text-body text-ink placeholder:text-muted hover:border-hairline-strong focus:border-cobalt outline-none transition-colors font-mono"
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? t("settings.apiKey.hide") : t("settings.apiKey.show")}
          aria-pressed={showKey}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink transition-colors rounded"
        >
          {showKey ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
      <button
        onClick={() => void handleSaveCheck()}
        disabled={loading || value.trim().length === 0}
        className="lt-press shrink-0 h-11 px-5 rounded-pill bg-cobalt hover:bg-cobalt-deep disabled:opacity-40 disabled:hover:bg-cobalt text-white text-caption font-medium inline-flex items-center justify-center min-w-24"
      >
        {loading ? <Spinner size="sm" /> : t("settings.apiKey.saveCheck")}
      </button>
      <KeyStatusChip status={keyStatus} />
    </div>
  );
}

/** Pure status chip — extracted so it can be tested independently. */
export function KeyStatusChip({ status }: { status: KeyStatus | null }) {
  const { t } = useTranslation();

  const base =
    "inline-flex items-center h-7 px-3 rounded-pill text-code font-medium shrink-0";

  if (!status || status.state === "missing") {
    return (
      <span className={`${base} bg-surface-2 text-muted`}>
        {t("settings.apiKey.missing")}
      </span>
    );
  }
  if (status.state === "valid") {
    return (
      <span className={`${base} bg-ok-tint text-ok-deep`}>
        {t("settings.apiKey.valid")}
      </span>
    );
  }
  if (status.state === "invalid") {
    return (
      <Tooltip>
        <TooltipTrigger>
          <span className={`${base} bg-danger-tint text-danger-deep`}>
            {t("settings.apiKey.invalid")}
          </span>
        </TooltipTrigger>
        <TooltipContent>{status.reason}</TooltipContent>
      </Tooltip>
    );
  }
  const message = status.state === "error" ? status.message : "";
  return (
    <Tooltip>
      <TooltipTrigger>
        <span className={`${base} bg-warn-tint text-warn-deep`}>
          {t("settings.apiKey.error")}
        </span>
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}
