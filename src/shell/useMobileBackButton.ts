import { App } from "@capacitor/app";
import { useEffect } from "react";
import { toast } from "sonner";
import { i18n } from "@/i18n";
import { getShellKind } from "@/runtime/shell-policy";
import { dismissTopOverlayViaEscape, runMobileBackHandlers } from "@/shell/mobile-back-handler";

const ROOT_EXIT_WINDOW_MS = 2000;

let rootBackPressCount = 0;
let rootBackPressTimer: ReturnType<typeof setTimeout> | null = null;
let mobileBackConsumers = 0;
let mobileBackListener: { remove: () => Promise<void> } | null = null;
let mobileBackRegistration: Promise<void> | null = null;

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

async function dispatchMobileBack() {
  if (runMobileBackHandlers()) return;
  if (dismissTopOverlayViaEscape()) return;
  await handleRootBack();
}

function retainMobileBackListener() {
  mobileBackConsumers += 1;
  if (mobileBackRegistration) return;
  mobileBackRegistration = (async () => {
    await App.toggleBackButtonHandler({ enabled: false });
    const registered = await App.addListener("backButton", () => void dispatchMobileBack());
    mobileBackListener = registered;
    if (mobileBackConsumers === 0) {
      mobileBackListener = null;
      await registered.remove();
      await App.toggleBackButtonHandler({ enabled: true });
      mobileBackRegistration = null;
    }
  })();
}

function releaseMobileBackListener() {
  mobileBackConsumers = Math.max(0, mobileBackConsumers - 1);
  if (mobileBackConsumers > 0) return;
  resetRootBackPress();
  void mobileBackRegistration?.then(async () => {
    if (mobileBackConsumers > 0 || !mobileBackListener) return;
    const registered = mobileBackListener;
    mobileBackListener = null;
    await registered.remove();
    await App.toggleBackButtonHandler({ enabled: true });
    mobileBackRegistration = null;
  });
}

export function useMobileBackButton() {
  useEffect(() => {
    if (getShellKind() !== "mobile") return;
    retainMobileBackListener();
    return releaseMobileBackListener;
  }, []);
}
