import { describe, expect, it } from "vite-plus/test";
import { getSessionColorBorderClass, SESSION_COLORS } from "./session-colors";

describe("session color configuration", () => {
  it("provides a translated label, swatch, and session border for every color", () => {
    expect(SESSION_COLORS).toHaveLength(9);
    expect(new Set(SESSION_COLORS.map(({ value }) => value)).size).toBe(9);

    for (const color of SESSION_COLORS) {
      expect(color.labelKey).toMatch(/^sessionMenu\.colors\./);
      expect(color.swatchClassName).not.toBe("");
      expect(getSessionColorBorderClass(color.value)).toBe(color.borderClassName);
    }
  });

  it("uses the neutral border for absent or unknown persisted colors", () => {
    expect(getSessionColorBorderClass(undefined)).toBe("border-sidebar-border");
    expect(getSessionColorBorderClass("unknown" as never)).toBe("border-sidebar-border");
  });
});
