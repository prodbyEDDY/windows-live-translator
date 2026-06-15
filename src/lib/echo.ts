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

/**
 * True when the output device name looks like loudspeakers. Windows reliably
 * includes the form-factor word in the endpoint's friendly name ("Speakers
 * (Realtek…)" / "Динамики …"), so a positive speaker match is a low-false-positive
 * signal that the user is at acoustic-echo risk (mic re-captures the peer's voice
 * and the OUT session translates it straight back to them).
 */
const SPEAKER_REGEXP = /speaker|loudspeaker|колонк|динамик/i;
export function looksLikeSpeakers(name: string | null | undefined): boolean {
  if (!name) return false;
  return SPEAKER_REGEXP.test(name);
}

/**
 * True when a CAPTURE (input) device is actually a render-loopback / monitor mix
 * — "CABLE Output", "Stereo Mix" / "Стерео микшер", "What U Hear", "Wave Out Mix".
 * Picking one as the app microphone makes the OUT session capture the call/system
 * audio and translate the peer right back to themselves, so the mic picker hides
 * these (the backend also refuses them — see `is_loopback_capture_name`).
 */
const LOOPBACK_CAPTURE_REGEXP =
  /cable output|stereo mix|стерео микшер|what u hear|what you hear|wave out mix|loopback/i;
export function isLoopbackCaptureDevice(name: string | null | undefined): boolean {
  if (!name) return false;
  return LOOPBACK_CAPTURE_REGEXP.test(name);
}
