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
      <div className="w-full max-w-[920px] mx-auto px-6 py-6 flex flex-col gap-5 flex-1 min-h-0">
        {(title || toolbar) && (
          <div className="flex items-end justify-between gap-4 shrink-0">
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

/** A card-section title in the studio style: Unbounded uppercase letterspaced. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-display text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">
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
      className={`bg-surface border border-hairline rounded-card shadow-studio ${className}`}
    >
      {children}
    </div>
  );
}
