/** Shared display formatters (extracted so screens don't each re-define them). */

/** Formats seconds as mm:ss (e.g. 65 → "01:05"). */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Maps an i18next language code to a BCP-47 locale for Intl/toLocaleString. */
export function localeFor(lang: string | undefined): string {
  return lang === "ru" ? "ru-RU" : "en-US";
}
