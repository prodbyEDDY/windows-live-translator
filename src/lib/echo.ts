/**
 * Heuristic for "does this output device look like headphones?".
 *
 * Playing translated audio through speakers risks feeding it back into the mic
 * (echo). Headphone-like devices avoid that. The match is intentionally loose
 * and bilingual (RU + EN). Shared by the Live screen and the setup wizard.
 */
const HEADPHONE_REGEXP = /наушник|headphone|headset|earbud|airpod|buds/i;

/** True when the device name looks like headphones (echo-safe). */
export function looksLikeHeadphones(name: string | null | undefined): boolean {
  if (!name) return false;
  return HEADPHONE_REGEXP.test(name);
}
