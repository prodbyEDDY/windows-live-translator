import { describe, it, expect } from "vitest";
import { dbToPercent } from "../LevelMeter";

describe("dbToPercent", () => {
  it("maps -60 dB (minimum) to 0%", () => {
    expect(dbToPercent(-60)).toBe(0);
  });

  it("maps 0 dB (maximum) to 100%", () => {
    expect(dbToPercent(0)).toBe(100);
  });

  it("maps midpoint -30 dB to 50%", () => {
    expect(dbToPercent(-30)).toBe(50);
  });

  it("clamps values below -60 to 0%", () => {
    expect(dbToPercent(-80)).toBe(0);
    expect(dbToPercent(-100)).toBe(0);
    expect(dbToPercent(-Infinity)).toBe(0);
  });

  it("clamps values above 0 to 100%", () => {
    expect(dbToPercent(10)).toBe(100);
    expect(dbToPercent(3)).toBe(100);
  });

  it("maps -45 dB to 25%", () => {
    expect(dbToPercent(-45)).toBe(25);
  });

  it("maps -15 dB to 75%", () => {
    expect(dbToPercent(-15)).toBe(75);
  });
});
