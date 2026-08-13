/** PROTOTYPE ONLY — session multi-selection design directions. */
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { SessionMultiSelectPrototype } from "@/components/SessionMultiSelect.prototype";
import en from "@/i18n/locales/en.json";
import "./index.css";

await i18n.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<SessionMultiSelectPrototype />);
