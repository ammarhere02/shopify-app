import { describe, expect, it } from "vitest";
import { contrastRatio, readableTextColor } from "../app/lib/badge-contrast";

describe("readableTextColor", () => {
  it.each([
    ["#000000", "#FFFFFF"],
    ["#1A7F37", "#FFFFFF"],
    ["#0000FF", "#FFFFFF"],
    ["#FFFFFF", "#000000"],
    ["#FFFF00", "#000000"],
    ["#FF9900", "#000000"],
  ])("background %s gets %s text", (background, text) => {
    expect(readableTextColor(background)).toBe(text);
  });

  it("always reaches at least WCAG AA (4.5:1) for the chosen text color", () => {
    for (let i = 0; i < 4096; i++) {
      const hex = "#" + (i * 4099).toString(16).padStart(6, "0").slice(-6).toUpperCase();
      expect(contrastRatio(hex, readableTextColor(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
