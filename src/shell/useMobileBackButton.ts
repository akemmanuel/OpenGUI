import { App } from "@capacitor/app";
import { useEffect } from "react";
import { toast } from "sonner";
import { i18n } from "@/i18n";
import { getShellKind } from "@/runtime/shell-policy";
import { dismissTopOverlayViaEscape, runMobileBackHandlers } from "@/shell/mobile-back-handler";

const ROOT_EXIT_WINDOW_MS = 2000;

let rootBackPressCount = 0;
let rootBackPressTimer: ReturnType<typeof setTimeout> | null = null;

function resetRootBackPress() {
  rootBackPressCount = 0;
  if (rootBackPressTimer !== null) {
    clearTimeout(rootBackPressTimer);
    rootBackPressTimer = null;
  }
}

function scheduleRootBackReset() {
  if (rootBackPressTimer !== null) clearTimeout(rootBackPressTimer);
  rootBackPressTimer = setTimeout(() => {
    rootBackPressCount = 0;
    rootBackPressTimer = null;
  }, ROOT_EXIT_WINDOW_MS);
}

async function handleRootBack(): Promise<void> {
  rootBackPressCount += 1;
  if (rootBackPressCount >= 2) {
    resetRootBackPress();
    await App.exitApp();
    return;
  }
  scheduleRootBackReset();
  toast(i18n.t("mobile.backAgainToExit"), { duration: ROOT_EXIT_WINDOW_MS });
}

export function useMobileBackButton() {
  useEffect(() => {
    if (getShellKind() !== "mobile") return;

    let cancelled = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      await App.toggleBackButtonHandler({ enabled: false });
      const registered = await App.addListener("backButton", () => {
        void (async () => {
          if (runMobileBackHandlers()) return;
          if (dismissTopOverlayViaEscape()) return;
          await handleRootBack();
        })();
      });
      if (cancelled) {
        void registered.remove();
        return;
      }
      listener = registered;
    })();

    return () => {
      cancelled = true;
      resetRootBackPress();
      void listener?.remove();
      void App.toggleBackButtonHandler({ enabled: true });
    };
  }, []);
}
