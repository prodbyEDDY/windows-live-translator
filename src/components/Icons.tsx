/**
 * Inline SVG icon set — stroke 1.5, 24×24 viewBox, currentColor.
 * Hand-drawn consistent set for nav + UI chrome.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 20, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...props,
  };
}

/** Waveform — Live. */
export function IconWaveform(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 12v0" />
      <path d="M7.5 8.5v7" />
      <path d="M11 5v14" />
      <path d="M14.5 8.5v7" />
      <path d="M18 10.5v3" />
      <path d="M21 12v0" />
    </svg>
  );
}

/** Mic + message bubble — Voice. */
export function IconMicMessage(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5z" />
      <rect x="10.5" y="6.5" width="3" height="5" rx="1.5" />
      <path d="M9 10.2a3 3 0 0 0 6 0" />
    </svg>
  );
}

/** Clock with reverse arrow — History. */
export function IconHistory(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 9a9 9 0 1 1-1 5" />
      <path d="M3.5 4.5V9H8" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  );
}

/** Gear — Settings. */
export function IconGear(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </svg>
  );
}

/** Swap arrows — language pair. */
export function IconSwap(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M7 4 3.5 7.5 7 11" />
      <path d="M3.5 7.5H17" />
      <path d="M17 20l3.5-3.5L17 13" />
      <path d="M20.5 16.5H7" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 12.5 9.5 17 19 6.5" />
    </svg>
  );
}

export function IconCross(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconMic(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
      <path d="M12 17.5V21M8.5 21h7" />
    </svg>
  );
}

export function IconStopSquare(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.8-4.8" />
    </svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 20h15" />
    </svg>
  );
}

export function IconGrip(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Eye — show / reveal the API key. */
export function IconEye(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Eye with a slash — hide / mask the API key. */
export function IconEyeOff(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a16.6 16.6 0 0 1-2.5 3.4" />
      <path d="M6.2 6.7A16.4 16.4 0 0 0 2.5 12s3.5 7 9.5 7a9.3 9.3 0 0 0 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3.5 3.5 20.5 20.5" />
    </svg>
  );
}

/** Animated 3-bar waveform glyph for the wordmark. */
export function WaveformGlyph({ active }: { active: boolean }) {
  return (
    <span
      className="inline-flex items-end gap-[2px] h-[14px]"
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`w-[2.5px] rounded-full bg-cobalt ${active ? "lt-wave-bar" : ""}`}
          style={{
            height: active ? "100%" : ["55%", "100%", "70%"][i],
            animationDelay: active ? `${i * 150}ms` : undefined,
          }}
        />
      ))}
    </span>
  );
}
