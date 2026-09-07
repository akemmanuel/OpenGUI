import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { onSettingsChange, storageGet, storageSet } from "@/lib/persistence/storage";

export function isRespondingSidebarEnabled() {
  return storageGet(STORAGE_KEYS.RESPONDING_SIDEBAR) !== "false";
}

export function setRespondingSidebarEnabled(enabled: boolean) {
  storageSet(STORAGE_KEYS.RESPONDING_SIDEBAR, String(enabled));
}

export function useRespondingSidebarEnabled() {
  const [enabled, setEnabled] = useState(isRespondingSidebarEnabled);
  useEffect(
    () =>
      onSettingsChange(({ key }) => {
        if (key === STORAGE_KEYS.RESPONDING_SIDEBAR) setEnabled(isRespondingSidebarEnabled());
      }),
    [],
  );
  return enabled;
}
