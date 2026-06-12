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
  uiLang: string;
  wizardDone: boolean;
  ttsVoice: string;
}

export interface LiveConfig {
  myLang: string;
  peerLang: string;
  micId: string | null;
  outputId: string | null;
  captureMode: "app" | "system";
  appPid: number | null;
  echoTargetLanguage: boolean;
  duckingEnabled: boolean;
  duckLevel: number;
  testMode: boolean;
}

export interface TranscriptEvent {
  direction: "in" | "out";
  kind: "original" | "translated";
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
  devicesList: () => invoke<DevicesPayload>("devices_list"),
  audioAppsList: () => invoke<AppSession[]>("audio_apps_list"),
  liveStart: (cfg: LiveConfig) => invoke<void>("live_start", { cfg }),
  liveStop: () => invoke<void>("live_stop"),
  voiceImport: (path: string, targetLang: string) =>
    invoke<number>("voice_import", { path, targetLang }),
  voiceRecordStart: (micId: string | null) =>
    invoke<void>("voice_record_start", { micId }),
  voiceRecordStop: (myLang: string, peerLang: string, ttsVoice: string) =>
    invoke<number>("voice_record_stop", { myLang, peerLang, ttsVoice }),
  voiceRetry: (id: number) => invoke<void>("voice_retry", { id }),
  voiceList: (search?: string) =>
    invoke<VoiceRecord[]>("voice_list", { search: search ?? null }),
  voiceGet: (id: number) => invoke<VoiceRecord | null>("voice_get", { id }),
  voiceExport: (id: number, dest: string) =>
    invoke<void>("voice_export", { id, dest }),
  historyListCalls: (search?: string) =>
    invoke<CallRecord[]>("history_list_calls", { search: search ?? null }),
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
};
