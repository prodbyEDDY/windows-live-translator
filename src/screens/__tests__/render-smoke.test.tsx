// Render-smoke tests: every screen must mount in jsdom without throwing.
// A render exception in the real app unmounts the whole tree (no error
// boundary) and shows a white screen — these tests catch that class of bug.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "../../i18n";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(() => Promise.resolve(() => {})) }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  resolveResource: vi.fn(() => Promise.resolve("C:/resources/drag-audio.png")),
}));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/ipc")>();
  return {
    ...orig,
    ipc: {
      ...orig.ipc,
      settingsGet: vi.fn(() => Promise.resolve(null)),
      historyListCalls: vi.fn(() => Promise.resolve([])),
      historyListVoice: vi.fn(() => Promise.resolve([])),
      voiceList: vi.fn(() => Promise.resolve([])),
      devicesList: vi.fn(() =>
        Promise.resolve({ inputs: [], outputs: [], cablePresent: false })
      ),
      audioAppsList: vi.fn(() => Promise.resolve([])),
      apiKeyStatus: vi.fn(() => Promise.resolve({ state: "missing" })),
      wizardState: vi.fn(() =>
        Promise.resolve({ keyPresent: false, cablePresent: false })
      ),
    },
  };
});

import { HistoryScreen } from "../HistoryScreen";
import { VoiceScreen } from "../VoiceScreen";
import { LiveScreen } from "../LiveScreen";
import { SettingsScreen } from "../SettingsScreen";
import { WizardScreen } from "../WizardScreen";

describe("screens mount without throwing", () => {
  it("HistoryScreen", () => {
    expect(() => render(<HistoryScreen />)).not.toThrow();
  });
  it("VoiceScreen", () => {
    expect(() => render(<VoiceScreen />)).not.toThrow();
  });
  it("LiveScreen", () => {
    expect(() => render(<LiveScreen />)).not.toThrow();
  });
  it("SettingsScreen", () => {
    expect(() => render(<SettingsScreen />)).not.toThrow();
  });
  it("WizardScreen", () => {
    expect(() => render(<WizardScreen />)).not.toThrow();
  });
  it("HistoryScreen shows empty state", async () => {
    render(<HistoryScreen />);
    expect(await screen.findAllByText(/нет|пока|empty/i)).toBeTruthy();
  });
});
