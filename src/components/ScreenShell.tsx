import type { ReactNode } from "react";

/**
 * A card-section title: 11px Unbounded uppercase letterspaced muted, preceded
 * by a 16px-wide cobalt rule.
 *
 * (The former `ScreenShell` / `Card` wrappers that lived here were unused —
 * every screen manages its own layout — so they were removed. Only this
 * section-title helper is consumed, by SettingsScreen.)
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
      <span className="inline-block w-4 h-[2px] rounded-full bg-cobalt shrink-0" />
      {children}
    </h2>
  );
}
