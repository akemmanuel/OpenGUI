// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("@/runtime/clients", () => ({
  getDesktopShellClient: () => ({ platform: { getSystemLocale: async () => "en-US" } }),
}));

import { i18n, initI18n } from "./index";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

test("keeps the document language aligned with live German and Spanish translations", async () => {
  await initI18n();
  await i18n.changeLanguage("de");
  expect(document.documentElement.lang).toBe("de");
  await i18n.changeLanguage("es");
  expect(document.documentElement.lang).toBe("es");
});
