import type { SettingsBridge } from "@/types/electron";

export function getSettingsBridge(): SettingsBridge | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI?.settings ?? null;
}
