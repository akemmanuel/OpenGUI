import * as React from "react";
import {
  getSessionDraftImages,
  persistSessionDraftImages,
  type SessionDraftMap,
} from "@/lib/session-drafts";

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
  const [imagePreviews, setImagePreviews] = React.useState<string[]>([]);
  const syncingTextRef = React.useRef(false);
  const syncingImagesRef = React.useRef(false);
  const sessionDraftsRef = React.useRef(sessionDrafts);
  const sessionDraftImagesRef = React.useRef(getSessionDraftImages());

  React.useEffect(() => {
    sessionDraftsRef.current = sessionDrafts;
  }, [sessionDrafts]);

  React.useEffect(() => {
    syncingTextRef.current = true;
    syncingImagesRef.current = true;
    setValue(draftKey ? (sessionDraftsRef.current[draftKey] ?? "") : "");
    setImagePreviews(draftKey ? [...(sessionDraftImagesRef.current[draftKey] ?? [])] : []);
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

  React.useEffect(() => {
    if (!draftKey) return;
    if (syncingImagesRef.current) {
      syncingImagesRef.current = false;
      return;
    }
    const existingImages = sessionDraftImagesRef.current[draftKey] ?? [];
    const unchanged =
      existingImages.length === imagePreviews.length &&
      existingImages.every((image, index) => image === imagePreviews[index]);
    if (unchanged) return;
    const next = { ...sessionDraftImagesRef.current };
    if (imagePreviews.length === 0) {
      delete next[draftKey];
    } else {
      next[draftKey] = [...imagePreviews];
    }
    sessionDraftImagesRef.current = next;
    persistSessionDraftImages(next);
  }, [draftKey, imagePreviews]);

  const clearPromptDraft = React.useCallback(() => {
    if (draftKey) {
      clearSessionDraft(draftKey);
      const next = { ...sessionDraftImagesRef.current };
      delete next[draftKey];
      sessionDraftImagesRef.current = next;
      persistSessionDraftImages(next);
    }
    setValue("");
    setImagePreviews([]);
  }, [clearSessionDraft, draftKey]);

  return {
    value,
    setValue,
    imagePreviews,
    setImagePreviews,
    clearPromptDraft,
  };
}
