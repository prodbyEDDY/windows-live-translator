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
import { appendTranscriptMut, type TranscriptLine } from "../lib/transcript";
import { shouldSaveCall } from "../lib/history";
import type { UnlistenFn } from "@tauri-apps/api/event";

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
  /** True while a high-level start is in flight (re-entrancy guard). */
  starting: boolean;

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

/**
 * The store only holds the last {@link MAX_UI_LINES} transcript lines so a long
 * session can't grow the rendered tree unbounded. The FULL transcript lives in
 * this module-scoped, mutable array OUTSIDE the store (no re-renders) and is
 * what we persist to history on stop.
 */
const MAX_UI_LINES = 400;
let fullTranscript: TranscriptLine[] = [];

/** Awaited Tauri event unlisteners, registered in init() (HMR-safe cleanup). */
let eventUnlisteners: UnlistenFn[] = [];

/**
 * One-shot guard for the terminal-error auto-stop: the backend keeps emitting
 * `phase:"error"` events, but we only want to react (drain + surface) on the
 * transition INTO the error phase, not on every repeat.
 */
let prevPhase: string | null = null;

/** Phase values that represent a healthy / expected session state. */
const KNOWN_SESSION_STATES = new Set([
  "off",
  "connecting",
  "running",
  "reconnecting",
  "source_lost",
]);

/**
 * Extract a human-readable reason from a terminal-error live event.
 *
 * The backend signals a failed session via `phase:"error"` and stuffs the
 * actual cause into whichever direction session string is abnormal — i.e. not
 * one of the known healthy states, or the explicit `source_lost` marker.
 * Returns an i18n key for `source_lost`, the raw string for any other unknown
 * direction state, or `null` when neither side carries a recognizable reason.
 */
export function deriveErrorReason(ev: {
  outSession: string;
  inSession: string;
}): string | null {
  for (const s of [ev.outSession, ev.inSession]) {
    if (s === "source_lost") return "__sourceLost__";
    if (!KNOWN_SESSION_STATES.has(s)) return s;
  }
  return null;
}

/**
 * Auto-stop handler for terminal session failures (fix B0 / AUTO-STOP).
 *
 * Backend leaves a dead controller in state after `phase:"error"`, so a later
 * `live_start` keeps returning `already_running`. On the transition INTO the
 * error phase we (a) surface a human reason, (b) fire-and-forget `liveStop()`
 * to drain the dead controller, and (c) clear the duration timer state.
 */
function handleLiveStateForAutoStop(
  ev: LiveStateEvent,
  set: (partial: Partial<AppState>) => void
): void {
  const enteringError = ev.phase === "error" && prevPhase !== "error";
  prevPhase = ev.phase;
  if (!enteringError) return;

  const reason = deriveErrorReason(ev);
  let message: string;
  if (reason === "__sourceLost__") {
    message = i18next.t("live.error.sourceLost");
  } else if (reason) {
    message = `${i18next.t("live.error.sessionFailed")}: ${reason}`;
  } else {
    message = i18next.t("live.error.sessionFailed");
  }

  set({ lastError: message, durationSec: 0 });

  // Drain the dead controller so the next Start works again. Call the raw IPC
  // (not `stopLive`, which resets `lastError`) so the surfaced reason survives.
  void ipc.liveStop().catch(() => {
    // best-effort: a failed stop must not mask the original error
  });
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
  starting: false,

  init: async () => {
    // HMR safety: a hot module reload re-runs this module (resetting the
    // `eventUnlisteners`/`initialized` closure) while the previous listeners
    // are still live on the Tauri side. Drain any we previously stored before
    // registering fresh ones. Under React StrictMode (no module reset) the
    // array is empty and the once-guard below short-circuits.
    if (eventUnlisteners.length > 0) {
      for (const un of eventUnlisteners) {
        try {
          un();
        } catch {
          // best-effort
        }
      }
      eventUnlisteners = [];
    }

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

    // Subscribe to all events (once, guarded by module flag). The returned
    // unlisten promises are awaited and stored so init() can drain them on a
    // subsequent (HMR) re-run.
    const subscriptions = await Promise.all([
      ipc.onTranscript((ev) => {
        // Maintain the full (un-capped) transcript outside the store — no
        // re-render — then mirror only the last MAX_UI_LINES into the store.
        appendTranscriptMut(fullTranscript, ev, nextId);
        set({
          transcript:
            fullTranscript.length > MAX_UI_LINES
              ? fullTranscript.slice(-MAX_UI_LINES)
              : fullTranscript.slice(),
        });
      }),

      ipc.onLiveState((ev) => {
        set({ liveState: ev });
        handleLiveStateForAutoStop(ev, set);
      }),

      ipc.onLevels((ev) => {
        set({ levels: ev });
      }),

      ipc.onDevicesChanged((ev) => {
        set({ devices: ev });
      }),

      ipc.onCost((ev) => {
        set({ cost: ev });
      }),

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
      }),
    ]);

    eventUnlisteners = subscriptions;
  },

  patchSettings: async (p: Partial<Settings>) => {
    // Capture the pre-patch settings so we can roll back on failure.
    const previous = _get().settings;
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
      // Roll back the optimistic mutation so the UI doesn't show a value the
      // backend rejected.
      set({ settings: previous, lastError: String(e) });
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
    // Re-entrancy guard: ignore a second Start while one is already in flight.
    if (state.starting) return;
    const { settings, appPid } = state;
    if (!settings) return;
    set({ starting: true });
    try {
      // Fresh session: reset both the full (module-scope) transcript and the
      // capped store copy, plus any stale duration from a prior run.
      fullTranscript = [];
      state.clearTranscript();
      set({ durationSec: 0 });
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
    } finally {
      set({ starting: false });
    }
  },

  stopLiveSession: async () => {
    const state = _get();
    const { settings, durationSec } = state;
    // Save transcript before stopping (only if there is meaningful content).
    // Persist the FULL transcript, not the capped store copy.
    if (settings && shouldSaveCall(fullTranscript)) {
      try {
        await ipc.historySaveCall(
          settings.myLang,
          settings.peerLang,
          durationSec,
          JSON.stringify(fullTranscript)
        );
      } catch {
        // Non-fatal: losing the history record is preferable to blocking stop
      }
    }
    await state.stopLive();
  },

  clearTranscript: () => {
    fullTranscript = [];
    set({ transcript: [] });
  },

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
