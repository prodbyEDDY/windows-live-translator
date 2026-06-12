import { describe, it, expect } from "vitest";
import { canStart } from "../liveStart";
import type { KeyStatus } from "../ipc";

const validKey: KeyStatus = { state: "valid" };
const missingKey: KeyStatus = { state: "missing" };
const invalidKey: KeyStatus = { state: "invalid", reason: "bad key" };

describe("canStart", () => {
  it("returns ok when all conditions are met (system mode)", () => {
    const result = canStart(validKey, "system", null, true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns ok when all conditions are met (app mode with pid)", () => {
    const result = canStart(validKey, "app", 1234, true);
    expect(result.ok).toBe(true);
  });

  it("blocks when keyStatus is null", () => {
    const result = canStart(null, "system", null, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoKey");
  });

  it("blocks when keyStatus is missing", () => {
    const result = canStart(missingKey, "system", null, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoKey");
  });

  it("blocks when keyStatus is invalid", () => {
    const result = canStart(invalidKey, "system", null, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoKey");
  });

  it("blocks when cable is not present", () => {
    const result = canStart(validKey, "system", null, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoCable");
  });

  it("blocks when captureMode is app but appPid is null", () => {
    const result = canStart(validKey, "app", null, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoApp");
  });

  it("does NOT block when captureMode is system and appPid is null", () => {
    const result = canStart(validKey, "system", null, true);
    expect(result.ok).toBe(true);
  });

  it("key check takes priority over cable check", () => {
    const result = canStart(missingKey, "system", null, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoKey");
  });

  it("cable check takes priority over app-pid check", () => {
    const result = canStart(validKey, "app", null, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live.startBlockedNoCable");
  });
});
