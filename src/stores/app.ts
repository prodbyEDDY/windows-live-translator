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
  type LiveConfig,
  type VoiceRecord,
} from "../lib/ipc";
import { appendTranscript, type TranscriptLine } from "../lib/transcript";

export type Screen = "live" | "voice" | "history" | "settings" | "wizard";

interface AppState {
  settings: Settings | null;
  keyStatus: KeyStatus | null;
  devices: DevicesPayload | null;
  apps: AppSession[];
  liveState: LiveStateEvent | null;
  transcript: TranscriptLine[];
  levels: LevelsEvent | null;
  screen: Screen;
  lastError: string | null;
  voiceMessages: VoiceRecord[];

  init: () => Promise<void>;
  patchSettings: (p: Partial<Settings>) => Promise<void>;
  refreshApps: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  setScreen: (screen: Screen) => void;
  setKeyStatus: (ks: KeyStatus) => void;
  setLastError: (err: string | null) => void;
  startLive: (cfg: LiveConfig) => Promise<void>;
  stopLive: () => Promise<void>;
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
  screen: "live",
  lastError: null,
  voiceMessages: [],

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

  startLive: async (cfg: LiveConfig) => {
    set({ lastError: null });
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
