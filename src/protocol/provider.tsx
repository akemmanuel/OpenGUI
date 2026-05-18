import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { OpenGuiClient } from "@/protocol/client";
import { createHttpOpenGuiClient } from "@/protocol/http-client";

const OpenGuiClientContext = createContext<OpenGuiClient | null>(null);

export function OpenGuiClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: OpenGuiClient;
}) {
  const defaultClient = useMemo(() => {
    if (window.__openGuiTransport === "http") return createHttpOpenGuiClient();
    if (window.electronAPI?.openGui) {
      return createHttpOpenGuiClient({
        rpcImpl: window.electronAPI.openGui.invoke,
        subscribeBackendEvents: window.electronAPI.openGui.onBackendEvent,
        openDirectory: window.electronAPI.openDirectory,
        localCapabilities: true,
      });
    }
    return createHttpOpenGuiClient({ localCapabilities: true });
  }, []);
  return (
    <OpenGuiClientContext.Provider value={client ?? defaultClient}>
      {children}
    </OpenGuiClientContext.Provider>
  );
}

export function useOpenGuiClient() {
  const client = useContext(OpenGuiClientContext);
  if (!client) throw new Error("OpenGuiClientProvider is missing");
  return client;
}
