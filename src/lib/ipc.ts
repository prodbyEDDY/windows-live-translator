import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type KeyStatus =
  | { state: "missing" | "valid" }
  | { state: "invalid"; reason: string }
  | { state: "error"; message: string };

export interface DeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface DevicesPayload {
  inputs: DeviceInfo[];
  outputs: DeviceInfo[];
  cablePresent: boolean;
}

export interface AppSession {
  pid: number;
  name: string;
  /** Session is audibly rendering right now (vs merely existing, e.g. idle Zoom). */
  active: boolean;
}

export interface Settings {
  myLang: string;
  peerLang: string;
  micId: string | null;
  outputId: string | null;
  captureMode: "app" | "system";
  echoTargetLanguage: boolean;
  duckingEnabled: boolean;
  duckLevel: number;
  mixOriginal: boolean;
  mixGainDb: number;
  vadEconomy: boolean;
  uiLang: string;
  wizardDone: boolean;
  ttsVoice: string;
  /** Which engine voices recorded-message translations: Gemini prebuilt voices
   *  or the user's ElevenLabs cloned voice. */
  ttsProvider: "gemini" | "elevenlabs";
  /** ElevenLabs cloned voice id (the API key lives in the OS keyring). */
  elevenVoiceId: string;
  /** When no session runs, pipe the raw mic into VB-CABLE so the peer hears the
   *  original (untranslated) voice instead of silence. */
  idlePassthrough: boolean;
  /** Auto-close the live session after ~2 min with no translation activity. */
  idleAutoStop: boolean;
  /** Settings-file schema version (backend migration bookkeeping; not user-set). */
  settingsSchemaVersion: number;
}

export interface LiveConfig {
  myLang: string;
  peerLang: string;
  micId: string | null;
  outputId: string | null;
  captureMode: "app" | "system";
  appPid: number | null;
  /** Same-language passthrough for the IN direction (peer → you). The backend
   *  always sends echo=false to the OUT direction regardless of this. */
  echoTargetLanguage: boolean;
  /** Auto-close the session after ~2 min with no translation activity. */
  idleAutoStop: boolean;
  duckingEnabled: boolean;
  duckLevel: number;
  mixOriginal: boolean;
  mixGainDb: number;
  vadEconomy: boolean;
  testMode: boolean;
}

export interface TranscriptEvent {
  direction: "in" | "out";
  /** "close" is emitted by the backend on turn boundaries (empty text); it
   *  closes the last open line of `direction` without starting a new one. */
  kind: "original" | "translated" | "close";
  text: string;
}

export interface LiveStateEvent {
  phase: string;
  outSession: string;
  inSession: string;
}

export interface LevelsEvent {
  micDb: number;
  appDb: number;
  outDb: number;
}

export interface CostEvent {
  seconds: number;
  estimatedUsd: number;
}

/** A voice message row (camelCase mirror of `store::history::VoiceRecord`). */
export interface VoiceRecord {
  id: number;
  createdAt: string;
  /** "in" = received/dropped-in; "out" = recorded outgoing. */
  kind: "in" | "out";
  sourcePath: string;
  sourceLang: string | null;
  transcript: string | null;
  translation: string | null;
  translatedAudioPath: string | null;
  targetLang: string;
  /** pending|transcribing|synthesizing|done|error:<short> */
  stage: string;
}

/** A completed call row (camelCase mirror of `store::history::CallRecord`). */
export interface CallRecord {
  id: number;
  startedAt: string;
  myLang: string;
  peerLang: string;
  durationSecs: number;
  transcriptJson: string;
}

/** Emitted on `voice:progress` as a voice message moves through its pipeline. */
export interface VoiceProgressEvent {
  id: number;
  stage: string;
}

export const ipc = {
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (patch: Partial<Settings>) =>
    invoke<Settings>("settings_set", { patch }),
  apiKeyStatus: () => invoke<KeyStatus>("api_key_status"),
  apiKeySet: (key: string) => invoke<KeyStatus>("api_key_set", { key }),
  /** Optimistic presence check for a stored ElevenLabs key (no network). */
  elevenlabsStatus: () => invoke<KeyStatus>("elevenlabs_status"),
  /** Validate (get-voice) then store the ElevenLabs key + voice id. Pass a null
   *  `key` to reuse the stored key while changing only the voice id. */
  elevenlabsKeySet: (key: string | null, voiceId: string) =>
    invoke<KeyStatus>("elevenlabs_key_set", { key, voiceId }),
  devicesList: () => invoke<DevicesPayload>("devices_list"),
  ttsVoices: () => invoke<string[]>("tts_voices"),
  audioAppsList: () => invoke<AppSession[]>("audio_apps_list"),
  liveStart: (cfg: LiveConfig) => invoke<void>("live_start", { cfg }),
  liveStop: () => invoke<void>("live_stop"),
  voiceImport: (path: string, targetLang: string) =>
    invoke<number>("voice_import", { path, targetLang }),
  voiceRecordStart: (micId: string | null) =>
    invoke<void>("voice_record_start", { micId }),
  voiceRecordStop: (myLang: string, peerLang: string, ttsVoice: string) =>
    invoke<number>("voice_record_stop", { myLang, peerLang, ttsVoice }),
  /** Re-run a voice card's pipeline. Pass `targetLang` to re-translate into a
   *  new language (used when the user changes the language then retries); omit it
   *  to re-attempt with the row's existing target. */
  voiceRetry: (id: number, targetLang?: string) =>
    invoke<void>("voice_retry", { id, targetLang: targetLang ?? null }),
  voiceList: (search?: string) =>
    invoke<VoiceRecord[]>("voice_list", { search: search ?? null }),
  voiceGet: (id: number) => invoke<VoiceRecord | null>("voice_get", { id }),
  voiceExport: (id: number, dest: string) =>
    invoke<void>("voice_export", { id, dest }),
  historyListCalls: (search?: string) =>
    invoke<CallRecord[]>("history_list_calls", { search: search ?? null }),
  historyGetCall: (id: number) =>
    invoke<CallRecord | null>("history_get_call", { id }),
  historyListVoice: (search?: string) =>
    invoke<VoiceRecord[]>("history_list_voice", { search: search ?? null }),
  historySaveCall: (
    myLang: string,
    peerLang: string,
    durationSecs: number,
    transcriptJson: string
  ) =>
    invoke<number>("history_save_call", {
      myLang,
      peerLang,
      durationSecs,
      transcriptJson,
    }),
  historyClear: () => invoke<void>("history_clear"),
  wizardState: () =>
    invoke<{ keyPresent: boolean; cablePresent: boolean }>("wizard_state"),
  wizardInstallCable: () => invoke<void>("wizard_install_cable"),
  onTranscript: (
    cb: (e: TranscriptEvent) => void
  ): Promise<UnlistenFn> =>
    listen("live:transcript", (e) => cb(e.payload as TranscriptEvent)),
  onLiveState: (
    cb: (e: LiveStateEvent) => void
  ): Promise<UnlistenFn> =>
    listen("live:state", (e) => cb(e.payload as LiveStateEvent)),
  onLevels: (cb: (e: LevelsEvent) => void): Promise<UnlistenFn> =>
    listen("live:levels", (e) => cb(e.payload as LevelsEvent)),
  onDevicesChanged: (
    cb: (e: DevicesPayload) => void
  ): Promise<UnlistenFn> =>
    listen("devices:changed", (e) => cb(e.payload as DevicesPayload)),
  onVoiceProgress: (
    cb: (e: VoiceProgressEvent) => void
  ): Promise<UnlistenFn> =>
    listen("voice:progress", (e) => cb(e.payload as VoiceProgressEvent)),
  onCost: (cb: (e: CostEvent) => void): Promise<UnlistenFn> =>
    listen("live:cost", (e) => cb(e.payload as CostEvent)),
  /** Fired when the backend auto-closes an idle session to save credits. */
  onAutoStop: (
    cb: (e: { reason: string }) => void
  ): Promise<UnlistenFn> =>
    listen("live:auto_stop", (e) => cb(e.payload as { reason: string })),
};
