import { useEffect } from "react";
import { getShellKind } from "@/runtime/shell-policy";
import { registerMobileBackHandler } from "@/shell/mobile-back-handler";

/**
 * Registers a back handler while `active` is true (mobile shell only).
 */
export function useRegisterMobileBackHandler(
  priority: number,
  active: boolean,
  handler: () => boolean,
) {
  useEffect(() => {
    if (!active || getShellKind() !== "mobile") return;
    return registerMobileBackHandler(priority, handler);
  }, [priority, active, handler]);
}
