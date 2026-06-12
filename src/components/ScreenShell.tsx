import type { ReactNode } from "react";

/**
 * Centered content column shared by Voice / History / Settings screens.
 * Live screen manages its own full-height layout.
 */
export function ScreenShell({
  title,
  toolbar,
  children,
  scroll = true,
}: {
  title?: string;
  toolbar?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}) {
  return (
    <div className={`flex-1 min-h-0 flex flex-col ${scroll ? "overflow-y-auto" : "overflow-hidden"}`}>
      <div className="w-full max-w-[920px] mx-auto px-6 py-6 flex flex-col gap-5 flex-1 min-h-0 lt-screen-in">
        {(title || toolbar) && (
          <div className="flex items-center justify-between gap-4 shrink-0 min-h-9">
            {title && (
              <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none">
                {title}
              </h1>
            )}
            {toolbar}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * A card-section title: 11px Unbounded uppercase letterspaced muted, preceded
 * by a 16px-wide cobalt rule.
 */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
      <span className="inline-block w-4 h-[2px] rounded-full bg-cobalt shrink-0" />
      {children}
    </h2>
  );
}

/** A surface card. */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-surface border border-hairline rounded-card lt-card ${className}`}
    >
      {children}
    </div>
  );
}
