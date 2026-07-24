import { describe, expect, test } from "vite-plus/test";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translations", () => {
  test("German and Spanish expose the same user-facing keys as English", () => {
    const englishKeys = leafKeys(en).sort();
    expect(leafKeys(de).sort()).toEqual(englishKeys);
    expect(leafKeys(es).sort()).toEqual(englishKeys);
  });
});
