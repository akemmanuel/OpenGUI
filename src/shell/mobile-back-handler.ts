/** Higher priority runs first. */
export const MOBILE_BACK_PRIORITY = {
  SETUP_WIZARD: 800,
  PROVIDER_DIALOG: 750,
  MERGE: 700,
  MODEL_SELECTOR: 650,
  PROJECT_PATH: 630,
  SETTINGS_VIEW: 500,
  SIDEBAR: 400,
} as const;

/**
 * Priority-ordered handlers for Android hardware back / predictive back gesture.
 * Higher priority runs first. Register while overlays are open; unregister on close.
 */

export type MobileBackHandler = () => boolean;

interface RegisteredHandler {
  priority: number;
  id: number;
  handler: MobileBackHandler;
}

let nextId = 0;
const handlers: RegisteredHandler[] = [];

export function registerMobileBackHandler(
  priority: number,
  handler: MobileBackHandler,
): () => void {
  const id = nextId++;
  handlers.push({ priority, id, handler });
  handlers.sort((a, b) => b.priority - a.priority || b.id - a.id);
  return () => {
    const index = handlers.findIndex((entry) => entry.id === id);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export function runMobileBackHandlers(): boolean {
  for (const entry of handlers) {
    if (entry.handler()) return true;
  }
  return false;
}

/** Try closing the topmost open dialog/sheet via Escape (Base UI). */
export function dismissTopOverlayViaEscape(): boolean {
  if (typeof document === "undefined") return false;
  const openDialogs = document.querySelectorAll(
    '[data-slot="dialog-content"][data-open], [data-slot="sheet-content"][data-open]',
  );
  if (openDialogs.length === 0) return false;
  const top = openDialogs[openDialogs.length - 1];
  if (!top) return false;
  top.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
