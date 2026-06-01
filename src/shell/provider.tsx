import { createContext, type ReactNode, useContext } from "react";
import type { DesktopShellClient } from "@/shell/client";
import { getDesktopShellClient } from "@/runtime/clients";

const DesktopShellContext = createContext<DesktopShellClient | null>(null);

export function DesktopShellProvider({
  children,
  shell,
}: {
  children: ReactNode;
  shell?: DesktopShellClient;
}) {
  return (
    <DesktopShellContext.Provider value={shell ?? getDesktopShellClient()}>
      {children}
    </DesktopShellContext.Provider>
  );
}

export function useDesktopShell() {
  const shell = useContext(DesktopShellContext);
  if (!shell) throw new Error("DesktopShellProvider is missing");
  return shell;
}
