import * as React from "react";
import { type SessionDraftMap } from "@/lib/persistence/drafts";

export function usePromptDraft({
  draftKey,
  sessionDrafts,
  setSessionDraft,
  clearSessionDraft,
}: {
  draftKey: string | null;
  sessionDrafts: SessionDraftMap;
  setSessionDraft: (key: string, text: string) => void;
  clearSessionDraft: (key: string) => void;
}) {
  const [value, setValue] = React.useState("");
  const syncingTextRef = React.useRef(false);
  const sessionDraftsRef = React.useRef(sessionDrafts);

  React.useEffect(() => {
    sessionDraftsRef.current = sessionDrafts;
  }, [sessionDrafts]);

  React.useEffect(() => {
    syncingTextRef.current = true;
    setValue(draftKey ? (sessionDraftsRef.current[draftKey] ?? "") : "");
  }, [draftKey]);

  React.useEffect(() => {
    if (!draftKey) return;
    if (syncingTextRef.current) {
      syncingTextRef.current = false;
      return;
    }
    const existingDraft = sessionDrafts[draftKey] ?? "";
    if (value.trim().length === 0) {
      if (existingDraft) clearSessionDraft(draftKey);
      return;
    }
    if (existingDraft !== value) {
      setSessionDraft(draftKey, value);
    }
  }, [clearSessionDraft, draftKey, sessionDrafts, setSessionDraft, value]);

  const clearPromptDraft = React.useCallback(() => {
    if (draftKey) {
      clearSessionDraft(draftKey);
    }
    setValue("");
  }, [clearSessionDraft, draftKey]);

  return {
    value,
    setValue,
    clearPromptDraft,
  };
}
