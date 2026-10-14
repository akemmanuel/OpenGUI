// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("@/runtime/clients", () => ({
  getDesktopShellClient: () => ({ platform: { getSystemLocale: async () => "en-US" } }),
}));

import { i18n, initI18n } from "./index";
import de from "./locales/de.json";
import es from "./locales/es.json";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

test("pluralizes counted messages", async () => {
  await initI18n();
  expect(i18n.t("revertBanner.reverted", { count: 1 })).toBe("1 message reverted");
  expect(i18n.t("revertBanner.reverted", { count: 3 })).toBe("3 messages reverted");
  expect(i18n.t("toolLabels.matchCount", { count: 2 })).toBe("2 matches");
});

test("keeps the document language aligned with live German and Spanish translations", async () => {
  await initI18n();
  await i18n.changeLanguage("de");
  expect(document.documentElement.lang).toBe("de");
  expect(i18n.t("common.autoDetect")).toBe(de.common.autoDetect);
  await i18n.changeLanguage("es");
  expect(document.documentElement.lang).toBe("es");
  expect(i18n.t("common.autoDetect")).toBe(es.common.autoDetect);
});
