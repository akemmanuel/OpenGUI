import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet } from "@/lib/safe-storage";
import { getDesktopShellClient } from "@/runtime/clients";
import af from "./locales/af.json";
import ar from "./locales/ar.json";
import az from "./locales/az.json";
import bg from "./locales/bg.json";
import bn from "./locales/bn.json";
import bs from "./locales/bs.json";
import ca from "./locales/ca.json";
import cs from "./locales/cs.json";
import cy from "./locales/cy.json";
import da from "./locales/da.json";
import de from "./locales/de.json";
import el from "./locales/el.json";
import en from "./locales/en.json";
import eo from "./locales/eo.json";
import es from "./locales/es.json";
import et from "./locales/et.json";
import eu from "./locales/eu.json";
import fa from "./locales/fa.json";
import fi from "./locales/fi.json";
import fr from "./locales/fr.json";
import ga from "./locales/ga.json";
import gl from "./locales/gl.json";
import gu from "./locales/gu.json";
import he from "./locales/he.json";
import hi from "./locales/hi.json";
import hr from "./locales/hr.json";
import hu from "./locales/hu.json";
import hy from "./locales/hy.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ka from "./locales/ka.json";
import kk from "./locales/kk.json";
import km from "./locales/km.json";
import kn from "./locales/kn.json";
import ko from "./locales/ko.json";
import lo from "./locales/lo.json";
import lt from "./locales/lt.json";
import lv from "./locales/lv.json";
import mk from "./locales/mk.json";
import ml from "./locales/ml.json";
import mn from "./locales/mn.json";
import mr from "./locales/mr.json";
import ms from "./locales/ms.json";
import my from "./locales/my.json";
import nb from "./locales/nb.json";
import ne from "./locales/ne.json";
import nl from "./locales/nl.json";
import pa from "./locales/pa.json";
import pl from "./locales/pl.json";
import pt from "./locales/pt.json";
import ro from "./locales/ro.json";
import ru from "./locales/ru.json";
import si from "./locales/si.json";
import sk from "./locales/sk.json";
import sl from "./locales/sl.json";
import sq from "./locales/sq.json";
import sr from "./locales/sr.json";
import sv from "./locales/sv.json";
import sw from "./locales/sw.json";
import ta from "./locales/ta.json";
import te from "./locales/te.json";
import th from "./locales/th.json";
import tl from "./locales/tl.json";
import tr from "./locales/tr.json";
import uk from "./locales/uk.json";
import ur from "./locales/ur.json";
import uz from "./locales/uz.json";
import vi from "./locales/vi.json";
import zh from "./locales/zh.json";

const resources = {
  af: { translation: af },
  ar: { translation: ar },
  az: { translation: az },
  bg: { translation: bg },
  bn: { translation: bn },
  bs: { translation: bs },
  ca: { translation: ca },
  cs: { translation: cs },
  cy: { translation: cy },
  da: { translation: da },
  de: { translation: de },
  el: { translation: el },
  en: { translation: en },
  eo: { translation: eo },
  es: { translation: es },
  et: { translation: et },
  eu: { translation: eu },
  fa: { translation: fa },
  fi: { translation: fi },
  fr: { translation: fr },
  ga: { translation: ga },
  gl: { translation: gl },
  gu: { translation: gu },
  he: { translation: he },
  hi: { translation: hi },
  hr: { translation: hr },
  hu: { translation: hu },
  hy: { translation: hy },
  id: { translation: id },
  it: { translation: it },
  ja: { translation: ja },
  ka: { translation: ka },
  kk: { translation: kk },
  km: { translation: km },
  kn: { translation: kn },
  ko: { translation: ko },
  lo: { translation: lo },
  lt: { translation: lt },
  lv: { translation: lv },
  mk: { translation: mk },
  ml: { translation: ml },
  mn: { translation: mn },
  mr: { translation: mr },
  ms: { translation: ms },
  my: { translation: my },
  nb: { translation: nb },
  ne: { translation: ne },
  nl: { translation: nl },
  pa: { translation: pa },
  pl: { translation: pl },
  pt: { translation: pt },
  ro: { translation: ro },
  ru: { translation: ru },
  si: { translation: si },
  sk: { translation: sk },
  sl: { translation: sl },
  sq: { translation: sq },
  sr: { translation: sr },
  sv: { translation: sv },
  sw: { translation: sw },
  ta: { translation: ta },
  te: { translation: te },
  th: { translation: th },
  tl: { translation: tl },
  tr: { translation: tr },
  uk: { translation: uk },
  ur: { translation: ur },
  uz: { translation: uz },
  vi: { translation: vi },
  zh: { translation: zh },
} as const;

export type SupportedLanguage = keyof typeof resources;

export const SUPPORTED_LANGUAGE_LIST: readonly SupportedLanguage[] = [
  "af",
  "ar",
  "az",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "eo",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "ga",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "my",
  "nb",
  "ne",
  "nl",
  "pa",
  "pl",
  "pt",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "zh",
];

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
