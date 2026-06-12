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
};
