import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlert,
  IconCheckCircle,
  IconCross,
  IconInfo,
  IconWarning,
} from "./Icons";

type Tone = "warn" | "danger" | "ok" | "info";

interface BannerProps {
  tone: Tone;
  title?: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Per-tone surface: a quiet tint ground, a matching hairline border, a *-deep
 * ink for the title and leading icon. No side-stripe — tone reads from the
 * full tinted frame + the leading status icon.
 */
const TONE: Record<
  Tone,
  { tint: string; border: string; ink: string; Icon: ComponentType<IconProps> }
> = {
  info: {
    tint: "bg-cobalt-tint",
    border: "border-cobalt/25",
    ink: "text-cobalt-deep",
    Icon: IconInfo,
  },
  ok: {
    tint: "bg-ok-tint",
    border: "border-ok/25",
    ink: "text-ok-deep",
    Icon: IconCheckCircle,
  },
  warn: {
    tint: "bg-warn-tint",
    border: "border-warn/30",
    ink: "text-warn-deep",
    Icon: IconWarning,
  },
  danger: {
    tint: "bg-danger-tint",
    border: "border-danger/25",
    ink: "text-danger-deep",
    Icon: IconAlert,
  },
};

/** Inline alert — tinted card with a leading tone icon (no side-stripe). */
export function Banner({ tone, title, description, action, onDismiss }: BannerProps) {
  const { t } = useTranslation();
  const c = TONE[tone];
  const Icon = c.Icon;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-card border ${c.border} ${c.tint} px-3.5 py-3`}
    >
      <Icon
        size={18}
        className={`${c.ink} shrink-0 mt-px`}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {title && (
          <p className={`text-caption font-semibold ${c.ink}`}>{title}</p>
        )}
        {description && (
          <p className="text-caption text-ink-2 leading-snug">{description}</p>
        )}
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="lt-press shrink-0 px-3 h-7 rounded-pill text-label font-medium text-ink border border-hairline-strong bg-surface hover:border-ink-2/40"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md text-muted hover:text-ink hover:bg-black/[0.04] transition-colors"
        >
          <IconCross size={15} />
        </button>
      )}
    </div>
  );
}
