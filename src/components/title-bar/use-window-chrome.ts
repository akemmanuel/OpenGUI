import { useEffect, useState } from "react";
import { useDesktopShell } from "@/shell/provider";

export function useWindowChrome() {
  const shell = useDesktopShell();
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    shell.platform
      .getPlatform()
      .then(setPlatform)
      .catch(() => {});
    shell.window
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});
    return shell.window.onMaximizeChange(setIsMaximized);
  }, [shell]);

  return {
    shell,
    isMaximized,
    platform,
    isMac: platform === "darwin",
    isWebRuntime: !navigator.userAgent.includes("Electron"),
  };
}
