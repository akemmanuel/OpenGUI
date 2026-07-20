import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/persistence/storage";
import { getDesktopShellClient } from "@/runtime/clients";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";

const resources = {
  de: { translation: de },
  en: { translation: en },
  es: { translation: es },
} as const;

export type SupportedLanguage = keyof typeof resources;

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

export function initI18n(): Promise<typeof i18n> {
  if (!initPromise) {
    initPromise = detectInitialLanguage().then(async (language) => {
      await i18n.use(initReactI18next).init({
        resources,
        lng: language,
        fallbackLng: FALLBACK_LANGUAGE,
        interpolation: { escapeValue: false },
      });
      return i18n;
    });
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
