import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("every literal key passed to t() exists in English", () => {
    const englishKeys = new Set(
      leafKeys(en).map((key) => key.replace(/_(?:zero|one|two|few|many|other)$/u, "")),
    );
    const sourceRoot = join(import.meta.dirname, "..");
    const missing: string[] = [];
    for (const file of readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/u.test(file) || /\.test\.tsx?$/u.test(file)) continue;
      const source = readFileSync(join(sourceRoot, file), "utf8");
      for (const match of source.matchAll(/\bt\(\s*["']([a-zA-Z]\w*(?:\.\w+)+)["']/gu)) {
        if (!englishKeys.has(match[1] as string)) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("plurals use the _one/_other suffixes i18next resolves from count", () => {
    for (const keys of [leafKeys(en), leafKeys(de), leafKeys(es)]) {
      // i18next 21+ ignores the legacy _plural suffix, so its text never shows.
      expect(keys.filter((key) => key.endsWith("_plural"))).toEqual([]);
      for (const key of keys.filter((candidate) => candidate.endsWith("_one"))) {
        expect(keys).toContain(key.replace(/_one$/u, "_other"));
      }
    }
  });
});
