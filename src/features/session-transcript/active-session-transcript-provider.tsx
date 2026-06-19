import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ActiveSessionTranscriptStore } from "@/features/session-transcript/active-session-transcript-store";
import type { ActiveTranscriptSnapshot } from "@/features/session-transcript/transcript-input";

const ActiveTranscriptStoreContext = createContext<ActiveSessionTranscriptStore | null>(null);

export function ActiveSessionTranscriptProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ActiveSessionTranscriptStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new ActiveSessionTranscriptStore();
  }

  const store = storeRef.current;
  return (
    <ActiveTranscriptStoreContext.Provider value={store}>
      {children}
    </ActiveTranscriptStoreContext.Provider>
  );
}

export function useActiveTranscriptStore(): ActiveSessionTranscriptStore {
  const store = useContext(ActiveTranscriptStoreContext);
  if (!store) {
    throw new Error("useActiveTranscriptStore must be used within ActiveSessionTranscriptProvider");
  }
  return store;
}

export function useActiveTranscriptSnapshot(): ActiveTranscriptSnapshot {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}

export function useActiveTranscriptMessages(): ActiveTranscriptSnapshot["messages"] {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getSnapshot().messages,
    () => store.getSnapshot().messages,
  );
}

export function useActiveTranscriptHistory(): Pick<
  ActiveTranscriptSnapshot,
  "hasOlder" | "loadingOlder" | "phase"
> {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getHistorySnapshot(),
    () => store.getHistorySnapshot(),
  );
}

export function useActiveTranscriptPromptHistory(): readonly string[] {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getPromptHistory(),
    () => store.getPromptHistory(),
  );
}

export function useActiveTranscriptMessageOrder(): ActiveTranscriptSnapshot["messages"] {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getMessageOrderMessages() as ActiveTranscriptSnapshot["messages"],
    () => store.getMessageOrderMessages() as ActiveTranscriptSnapshot["messages"],
  );
}

export function useActiveTranscriptContextMessages(): ActiveTranscriptSnapshot["messages"] {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getContextMessages() as ActiveTranscriptSnapshot["messages"],
    () => store.getContextMessages() as ActiveTranscriptSnapshot["messages"],
  );
}

export function useActiveTranscriptCompactionTail(): ActiveTranscriptSnapshot["messages"] {
  const store = useActiveTranscriptStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.getCompactionTailMessages() as ActiveTranscriptSnapshot["messages"],
    () => store.getCompactionTailMessages() as ActiveTranscriptSnapshot["messages"],
  );
}
