import { describe, it, expect } from "vitest";
import { buildDeviceOptions, formatDb, formatPercent } from "../SettingsScreen";
import type { DeviceInfo } from "../../lib/ipc";

describe("buildDeviceOptions", () => {
  it("prepends a null-id system-default entry", () => {
    const devices: DeviceInfo[] = [
      { id: "dev1", name: "Microphone (Realtek)", isDefault: true },
      { id: "dev2", name: "Headset Mic", isDefault: false },
    ];
    const opts = buildDeviceOptions(devices);
    expect(opts[0].id).toBeNull();
    expect(opts).toHaveLength(3);
  });

  it("returns only the default entry for an empty device list", () => {
    const opts = buildDeviceOptions([]);
    expect(opts).toHaveLength(1);
    expect(opts[0].id).toBeNull();
  });

  it("maps device id and name correctly", () => {
    const devices: DeviceInfo[] = [
      { id: "abc", name: "Cable Output", isDefault: false },
    ];
    const opts = buildDeviceOptions(devices);
    expect(opts[1]).toEqual({ id: "abc", name: "Cable Output" });
  });
});

describe("formatPercent", () => {
  it("formats 0 as 0%", () => {
    expect(formatPercent(0)).toBe("0%");
  });

  it("formats 100 as 100%", () => {
    expect(formatPercent(100)).toBe("100%");
  });

  it("rounds fractional values", () => {
    expect(formatPercent(33.7)).toBe("34%");
  });
});

describe("formatDb", () => {
  it("formats 0 dB", () => {
    expect(formatDb(0)).toBe("0 dB");
  });

  it("formats negative dB", () => {
    expect(formatDb(-12)).toBe("-12 dB");
  });

  it("formats positive dB", () => {
    expect(formatDb(6)).toBe("6 dB");
  });
});
