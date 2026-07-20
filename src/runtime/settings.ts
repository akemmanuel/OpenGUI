import type { SettingsBridge } from "@/types/settings";

export function getSettingsBridge(): SettingsBridge | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI?.settings ?? null;
}
