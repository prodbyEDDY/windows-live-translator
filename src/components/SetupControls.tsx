import type { ReactNode } from "react";
import {
  ListBox,
  ListBoxItem,
  SelectRoot,
  SelectIndicator,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@heroui/react";
import { LANGUAGES, langLabel, langAutonym } from "../lib/languages";
import { IconSwap } from "./Icons";

/**
 * The shared building blocks for the per-mode "setup strips" at the top of the
 * Live and Voice pages: a uniform labeled control (small muted label above an
 * h-9 pill), a compact language picker, a swap button, and a compact device
 * picker. One vocabulary so both modes read as the same surface — the Settings
 * `DeviceSelect` (full-width Field) stays for the wizard / dense settings list.
 */

/** A setup-strip control: a small muted label above its input, fixed rhythm. */
export function LabeledControl({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-label text-muted font-medium px-1 leading-none">{label}</span>
      {children}
    </div>
  );
}

/** Compact language pill (mono code + native name), h-9. */
export function LangSelect({
  value,
  onChange,
  ariaLabel,
  tone,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  ariaLabel: string;
  tone: "out" | "in";
  disabled?: boolean;
}) {
  const ring =
    tone === "out"
      ? "border-cobalt/25 hover:border-cobalt/55 focus-within:border-cobalt/55"
      : "border-hairline hover:border-hairline-strong focus-within:border-hairline-strong";
  const codeColor = tone === "out" ? "text-cobalt" : "text-muted";
  return (
    <SelectRoot
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key))}
      aria-label={ariaLabel}
      isDisabled={disabled}
    >
      <SelectTrigger
        className={`lt-press inline-flex items-center gap-2 h-9 pl-2.5 pr-3 rounded-pill border bg-surface text-caption font-medium text-ink min-w-[126px] disabled:opacity-50 ${ring}`}
      >
        <span className={`font-mono text-label font-semibold leading-none ${codeColor}`}>
          {langLabel(value)}
        </span>
        <span className="leading-none truncate">{langAutonym(value)}</span>
      </SelectTrigger>
      <SelectPopover>
        <ListBox items={LANGUAGES} className="max-h-72 overflow-y-auto">
          {(lang) => (
            <ListBoxItem key={lang.code} id={lang.code} textValue={lang.autonym}>
              <span className="font-mono text-label text-muted mr-2">{langLabel(lang.code)}</span>
              {lang.autonym}
            </ListBoxItem>
          )}
        </ListBox>
      </SelectPopover>
    </SelectRoot>
  );
}

/** Round swap button sized to bottom-align with the h-9 pills it sits between. */
export function SwapButton({
  onPress,
  ariaLabel,
  disabled,
}: {
  onPress: () => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={ariaLabel}
      className="lt-swap inline-flex items-center justify-center w-9 h-9 rounded-full border border-hairline bg-surface text-muted hover:text-cobalt hover:border-cobalt/40 disabled:opacity-40 disabled:pointer-events-none shrink-0"
    >
      <IconSwap size={15} />
    </button>
  );
}

/** Compact device picker pill, h-9, with a missing-device → system-default fallback. */
export function DeviceSelectPill({
  value,
  onChange,
  options,
  sysDefault,
  onOpen,
  ariaLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: Array<{ id: string | null; name: string }>;
  sysDefault: string;
  onOpen: () => void;
  ariaLabel: string;
}) {
  // A saved device that no longer exists (unplugged) falls back to the
  // system-default selection rather than showing a dangling id.
  const missing = value != null && !options.some((o) => o.id === value);
  const selectedKey = missing ? "__default__" : (value ?? "__default__");
  return (
    <SelectRoot
      selectedKey={selectedKey}
      onSelectionChange={(key) => onChange(key === "__default__" ? null : String(key))}
      aria-label={ariaLabel}
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <SelectTrigger className="lt-press inline-flex items-center gap-2 h-9 pl-3 pr-2.5 rounded-pill border border-hairline bg-surface text-caption text-ink hover:border-hairline-strong min-w-[170px] max-w-[240px]">
        <SelectValue className="flex-1 text-left truncate" />
        <SelectIndicator />
      </SelectTrigger>
      <SelectPopover>
        <ListBox items={options} className="max-h-72 overflow-y-auto">
          {(item) => (
            <ListBoxItem
              key={item.id ?? "__default__"}
              id={item.id ?? "__default__"}
              textValue={item.id == null ? sysDefault : item.name}
            >
              {item.id == null ? sysDefault : item.name}
            </ListBoxItem>
          )}
        </ListBox>
      </SelectPopover>
    </SelectRoot>
  );
}
