import i18n, { type BackendModule, type ResourceKey } from "i18next";
import { initReactI18next } from "react-i18next";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/persistence/storage";
import { getDesktopShellClient } from "@/runtime/clients";
import en from "./locales/en.json";

export type SupportedLanguage = "en" | "de" | "es";

// English is the bundled fallback; other languages load on first use to keep startup small.
const localeLoaders: Record<SupportedLanguage, () => Promise<{ default: ResourceKey }>> = {
  en: async () => ({ default: en }),
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
};

const lazyLocales: BackendModule = {
  type: "backend",
  init() {},
  read(language, _namespace, callback) {
    const load = localeLoaders[language as SupportedLanguage];
    if (!load) return callback(null, {});
    load().then(
      (module) => callback(null, module.default),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  },
};

export const SUPPORTED_LANGUAGE_LIST: readonly SupportedLanguage[] = ["en", "de", "es"];

const FALLBACK_LANGUAGE: SupportedLanguage = "en";
const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(SUPPORTED_LANGUAGE_LIST);

function normalizeLanguage(input: string | null | undefined): SupportedLanguage | null {
  if (!input) return null;
  const baseLanguage = input.trim().toLowerCase().split(/[-_]/)[0];
  if (!baseLanguage) return null;
  return SUPPORTED_LANGUAGES.has(baseLanguage as SupportedLanguage)
    ? (baseLanguage as SupportedLanguage)
    : null;
}

export async function detectSystemLanguage(): Promise<SupportedLanguage> {
  let detectedLanguage: string | null = null;
  if (typeof window !== "undefined") {
    try {
      const locale = await getDesktopShellClient().platform.getSystemLocale();
      detectedLanguage = locale ?? null;
    } catch {
      detectedLanguage = null;
    }
    detectedLanguage ??= navigator.language ?? null;
  }

  return normalizeLanguage(detectedLanguage) ?? FALLBACK_LANGUAGE;
}

async function detectInitialLanguage(): Promise<SupportedLanguage> {
  const storedLanguage = normalizeLanguage(storageGet(STORAGE_KEYS.LANGUAGE));
  if (storedLanguage) return storedLanguage;

  return detectSystemLanguage();
}

let initPromise: Promise<typeof i18n> | null = null;
let subscribedToSettings = false;
let subscribedToDocumentLanguage = false;

function updateDocumentLanguage(language: string) {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export function initI18n(): Promise<typeof i18n> {
  if (!initPromise) {
    initPromise = detectInitialLanguage().then(async (language) => {
      await i18n
        .use(lazyLocales)
        .use(initReactI18next)
        .init({
          resources: { en: { translation: en } },
          partialBundledLanguages: true,
          lng: language,
          fallbackLng: FALLBACK_LANGUAGE,
          interpolation: { escapeValue: false },
        });
      updateDocumentLanguage(i18n.resolvedLanguage ?? language);
      return i18n;
    });
  }

  if (!subscribedToDocumentLanguage && typeof document !== "undefined") {
    subscribedToDocumentLanguage = true;
    i18n.on("languageChanged", updateDocumentLanguage);
  }

  if (!subscribedToSettings) {
    subscribedToSettings = true;
    onSettingsChange(({ key, value }) => {
      if (key !== STORAGE_KEYS.LANGUAGE) return;
      void (async () => {
        const nextLanguage = normalizeLanguage(value) ?? (await detectSystemLanguage());
        if (i18n.resolvedLanguage !== nextLanguage) {
          await i18n.changeLanguage(nextLanguage);
        }
      })();
    });
  }

  return initPromise!;
}

export { i18n };
