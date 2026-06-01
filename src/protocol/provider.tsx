import { createContext, type ReactNode, useContext } from "react";
import type { OpenGuiClient } from "@/protocol/client";
import { getOpenGuiClient } from "@/runtime/clients";

const OpenGuiClientContext = createContext<OpenGuiClient | null>(null);

export function OpenGuiClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: OpenGuiClient;
}) {
  return (
    <OpenGuiClientContext.Provider value={client ?? getOpenGuiClient()}>
      {children}
    </OpenGuiClientContext.Provider>
  );
}

export function useOpenGuiClient() {
  const client = useContext(OpenGuiClientContext);
  if (!client) throw new Error("OpenGuiClientProvider is missing");
  return client;
}
