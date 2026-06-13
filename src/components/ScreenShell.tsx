import type { ReactNode } from "react";

/**
 * A quiet card-section title: sentence-case, semibold, secondary ink.
 *
 * No leading colored rule and no uppercase tracking — those read as the
 * eyebrow / side-stripe scaffold the design system bans. Hierarchy comes from
 * weight + ink color, not from a kicker treatment.
 *
 * (The former `ScreenShell` / `Card` wrappers that lived here were unused —
 * every screen manages its own layout — so they were removed. Only this
 * section-title helper is consumed, by SettingsScreen.)
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-label font-semibold text-ink-2">{children}</h2>
  );
}
