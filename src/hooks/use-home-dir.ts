import { useEffect, useState } from "react";
import { useOpenGuiClient } from "@/protocol/provider";

/**
 * Returns the user's home directory via the Electron bridge.
 *
 * The value is fetched once on mount and cached for the lifetime of
 * the component. Returns an empty string while loading or when the
 * Electron API is unavailable.
 */
export function useHomeDir(): string {
  const client = useOpenGuiClient();
  const [homeDir, setHomeDir] = useState("");

  useEffect(() => {
    let cancelled = false;
    client.runtime
      .getHomeDir()
      .then((d) => {
        if (!cancelled) setHomeDir(d ?? "");
      })
      .catch(() => {
        /* runtime unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return homeDir;
}
