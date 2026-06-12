import { useTranslation } from "react-i18next";
import { IconCross } from "./Icons";

type Tone = "warn" | "danger" | "ok" | "info";

interface BannerProps {
  tone: Tone;
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

const TONE: Record<Tone, { bar: string; tint: string; title: string }> = {
  warn: { bar: "bg-warn", tint: "bg-[#b97d10]/[0.04]", title: "text-[#8a5d0a]" },
  danger: { bar: "bg-danger", tint: "bg-[#c2362b]/[0.04]", title: "text-danger" },
  ok: { bar: "bg-ok", tint: "bg-[#177e5b]/[0.04]", title: "text-ok" },
  info: { bar: "bg-cobalt", tint: "bg-cobalt-tint", title: "text-cobalt-deep" },
};

/** Hairline card with a colored left bar — the restyled Alert. */
export function Banner({ tone, title, description, action, onDismiss }: BannerProps) {
  const { t } = useTranslation();
  const c = TONE[tone];
  return (
    <div
      className={`relative flex items-start gap-3 rounded-card border border-hairline ${c.tint} pl-4 pr-3 py-2.5 overflow-hidden`}
    >
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${c.bar}`} />
      <div className="flex-1 min-w-0">
        {title && <p className={`text-[13px] font-semibold ${c.title}`}>{title}</p>}
        {description && (
          <p className="text-[12px] text-muted leading-snug mt-0.5">{description}</p>
        )}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="lt-press shrink-0 px-3 h-7 rounded-pill text-[12px] font-medium text-ink border border-hairline bg-surface hover:border-stone-300"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label={t("common.cancel")}
          className="shrink-0 text-muted hover:text-ink transition-colors mt-0.5"
        >
          <IconCross size={15} />
        </button>
      )}
    </div>
  );
}
