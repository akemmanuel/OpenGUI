import { useEffect, useState } from "react";

export function useHomeDir(): string {
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      ?.getHomeDir?.()
      .then((directory) => {
        if (!cancelled) setHomeDir(directory ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return homeDir;
}
