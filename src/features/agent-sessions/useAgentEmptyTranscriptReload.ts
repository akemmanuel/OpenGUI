import { useEffect, useRef } from "react";
import type { ActiveTranscriptSnapshot } from "@/features/session-transcript/transcript-input";

export function useAgentEmptyTranscriptReload(input: {
  activeSessionId: string | null;
  getTranscriptSnapshot: () => ActiveTranscriptSnapshot;
  reloadActiveTranscript: (sessionId: string) => Promise<boolean>;
}) {
  const { activeSessionId, getTranscriptSnapshot, reloadActiveTranscript } = input;
  const attemptedEmptySessionLoadRef = useRef<string | null>(null);

  useEffect(() => {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    const snap = getTranscriptSnapshot();
    if (!snap || snap.scope?.sessionId !== sessionId) return;
    if (snap.phase !== "empty" && snap.phase !== "error") return;
    if (attemptedEmptySessionLoadRef.current === sessionId) return;
    attemptedEmptySessionLoadRef.current = sessionId;
    void reloadActiveTranscript(sessionId);
  }, [activeSessionId, getTranscriptSnapshot, reloadActiveTranscript]);
}
