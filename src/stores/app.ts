import { create } from "zustand";
import i18next from "../i18n";
import {
  ipc,
  type Settings,
  type KeyStatus,
  type DevicesPayload,
  type AppSession,
  type LiveStateEvent,
  type LevelsEvent,
  type CostEvent,
  type LiveConfig,
  type VoiceRecord,
} from "../lib/ipc";
import { appendTranscript, type TranscriptLine } from "../lib/transcript";
import { shouldSaveCall } from "../lib/history";

export type Screen = "live" | "voice" | "history" | "settings" | "wizard";

interface AppState {
  settings: Settings | null;
  keyStatus: KeyStatus | null;
  devices: DevicesPayload | null;
  apps: AppSession[];
  liveState: LiveStateEvent | null;
  transcript: TranscriptLine[];
  levels: LevelsEvent | null;
  cost: CostEvent | null;
  screen: Screen;
  lastError: string | null;
  voiceMessages: VoiceRecord[];
  /** Selected app pid for "app" capture mode (lifted from LiveScreen so the
   *  header Start button can drive the session). */
  appPid: number | null;
  /** Session duration timer (seconds), driven by the live phase. */
  durationSec: number;

  init: () => Promise<void>;
  patchSettings: (p: Partial<Settings>) => Promise<void>;
  refreshApps: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  setScreen: (screen: Screen) => void;
  setKeyStatus: (ks: KeyStatus) => void;
  setLastError: (err: string | null) => void;
  setAppPid: (pid: number | null) => void;
  setDurationSec: (s: number | ((prev: number) => number)) => void;
  startLive: (cfg: LiveConfig) => Promise<void>;
  stopLive: () => Promise<void>;
  /** High-level start: clears transcript and starts from current settings + appPid. */
  startLiveSession: () => Promise<void>;
  /** High-level stop: persists the call to history (if meaningful) then stops. */
  stopLiveSession: () => Promise<void>;
  clearTranscript: () => void;
  loadVoice: () => Promise<void>;
  upsertVoice: (rec: VoiceRecord) => void;
}

let initialized = false;
let transcriptIdSeq = 0;
function nextId() {
  return ++transcriptIdSeq;
}

export const useAppStore = create<AppState>((set, _get) => ({
  settings: null,
  keyStatus: null,
  devices: null,
  apps: [],
  liveState: null,
  transcript: [],
  levels: null,
  cost: null,
  screen: "live",
  lastError: null,
  voiceMessages: [],
  appPid: null,
  durationSec: 0,

  init: async () => {
    if (initialized) return;
    initialized = true;

    try {
      const [settings, keyStatus, devices] = await Promise.all([
        ipc.settingsGet(),
        ipc.apiKeyStatus(),
        ipc.devicesList(),
      ]);

      set({ settings, keyStatus, devices });

      // Apply UI language from settings
      if (settings.uiLang) {
        await i18next.changeLanguage(settings.uiLang);
      }
    } catch (e) {
      set({ lastError: String(e) });
    }

    // Subscribe to all events (once, guarded by module flag)
    ipc.onTranscript((ev) => {
      set((state) => ({
        transcript: appendTranscript(state.transcript, ev, nextId),
      }));
    });

    ipc.onLiveState((ev) => {
      set({ liveState: ev });
    });

    ipc.onLevels((ev) => {
      set({ levels: ev });
    });

    ipc.onDevicesChanged((ev) => {
      set({ devices: ev });
    });

    ipc.onCost((ev) => {
      set({ cost: ev });
    });

    ipc.onVoiceProgress(async (ev) => {
      try {
        const rec = await ipc.voiceGet(ev.id);
        if (rec) {
          set((state) => ({
            voiceMessages: state.voiceMessages.some((m) => m.id === rec.id)
              ? state.voiceMessages.map((m) => (m.id === rec.id ? rec : m))
              : [rec, ...state.voiceMessages],
          }));
        }
      } catch {
        // best-effort
      }
    });
  },

  patchSettings: async (p: Partial<Settings>) => {
    // Optimistic update
    set((state) => ({
      settings: state.settings ? { ...state.settings, ...p } : state.settings,
    }));
    try {
      const updated = await ipc.settingsSet(p);
      set({ settings: updated });
      if (p.uiLang) {
        await i18next.changeLanguage(p.uiLang);
      }
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  refreshApps: async () => {
    try {
      const apps = await ipc.audioAppsList();
      set({ apps });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  refreshDevices: async () => {
    try {
      const devices = await ipc.devicesList();
      set({ devices });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  setScreen: (screen: Screen) => set({ screen }),

  setKeyStatus: (keyStatus: KeyStatus) => set({ keyStatus }),

  setLastError: (lastError: string | null) => set({ lastError }),

  setAppPid: (appPid: number | null) => set({ appPid }),

  setDurationSec: (s) =>
    set((state) => ({
      durationSec: typeof s === "function" ? s(state.durationSec) : s,
    })),

  startLive: async (cfg: LiveConfig) => {
    set({ lastError: null, cost: null });
    try {
      await ipc.liveStart(cfg);
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  stopLive: async () => {
    set({ lastError: null });
    try {
      await ipc.liveStop();
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  startLiveSession: async () => {
    const state = _get();
    const { settings, appPid } = state;
    if (!settings) return;
    state.clearTranscript();
    const captureMode = settings.captureMode;
    const cfg: LiveConfig = {
      myLang: settings.myLang,
      peerLang: settings.peerLang,
      micId: settings.micId,
      outputId: settings.outputId,
      captureMode: settings.captureMode,
      appPid: captureMode === "app" ? appPid : null,
      echoTargetLanguage: settings.echoTargetLanguage,
      duckingEnabled: settings.duckingEnabled,
      duckLevel: settings.duckLevel,
      mixOriginal: settings.mixOriginal,
      mixGainDb: settings.mixGainDb,
      vadEconomy: settings.vadEconomy,
      testMode: false,
    };
    await state.startLive(cfg);
  },

  stopLiveSession: async () => {
    const state = _get();
    const { settings, transcript, durationSec } = state;
    // Save transcript before stopping (only if there is meaningful content).
    if (settings && shouldSaveCall(transcript)) {
      try {
        await ipc.historySaveCall(
          settings.myLang,
          settings.peerLang,
          durationSec,
          JSON.stringify(transcript)
        );
      } catch {
        // Non-fatal: losing the history record is preferable to blocking stop
      }
    }
    await state.stopLive();
  },

  clearTranscript: () => set({ transcript: [] }),

  loadVoice: async () => {
    try {
      const voiceMessages = await ipc.voiceList();
      // newest first
      set({ voiceMessages: [...voiceMessages].reverse() });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  upsertVoice: (rec: VoiceRecord) => {
    set((state) => ({
      voiceMessages: state.voiceMessages.some((m) => m.id === rec.id)
        ? state.voiceMessages.map((m) => (m.id === rec.id ? rec : m))
        : [rec, ...state.voiceMessages],
    }));
  },
}));
