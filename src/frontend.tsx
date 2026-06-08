/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredAppearance } from "./hooks/use-theme";
import { initI18n } from "./i18n";
import { installWebElectronAPI } from "./lib/web-electron-api";
import { initializeRuntimeClients } from "./runtime/clients";

function preventDocumentPinchZoom() {
  const prevent = (event: Event) => event.preventDefault();
  const preventMultiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };

  document.addEventListener("gesturestart", prevent, { passive: false });
  document.addEventListener("gesturechange", prevent, { passive: false });
  document.addEventListener("gestureend", prevent, { passive: false });
  document.addEventListener("touchmove", preventMultiTouch, { passive: false });
}

preventDocumentPinchZoom();
installWebElectronAPI();
initializeRuntimeClients();
if (window.Capacitor?.isNativePlatform?.() === true) {
  document.documentElement.classList.add("capacitor-native");
}
applyStoredAppearance();

const elem = document.getElementById("root");
if (!elem) throw new Error("Root element not found");
// StrictMode removed: its double-mount behaviour causes IPC event
// subscriptions (e.g. SSE bridge) to fire twice, producing garbled
// streaming output in the Electron renderer.
const app = <App />;

async function renderApp() {
  await initI18n();
  if (import.meta.hot) {
    // With hot module reloading, `import.meta.hot.data` is persisted.
    if (!import.meta.hot.data.root) {
      import.meta.hot.data.root = createRoot(elem!);
    }
    const root = import.meta.hot.data.root;
    root.render(app);
    return;
  }

  // The hot module reloading API is not available in production.
  createRoot(elem!).render(app);
}

void renderApp();
