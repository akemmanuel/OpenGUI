import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useActiveTranscriptSnapshot } from "@/features/session-transcript/active-session-transcript-provider";
import { useSessionState, useWorkspaceState } from "@/hooks/use-agent-state";
import { isEditableTarget, isModKey, useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { STORAGE_KEYS } from "@/lib/constants";
import { collectChatFiles, sameHostPath, type ChatFile } from "@/lib/host-files";
import { storageParsed, storageSetJSON } from "@/lib/persistence/storage";

export type FilesPanelLocation =
  | { kind: "folder"; path: string }
  | { kind: "file"; path: string; line: number | null };

export const FILES_PANEL_MIN_WIDTH_PX = 300;
export const FILES_PANEL_MAX_WIDTH_PX = 960;
export const FILES_PANEL_DEFAULT_WIDTH_PX = 400;

export function clampFilesPanelWidth(width: number) {
  return Math.round(Math.min(FILES_PANEL_MAX_WIDTH_PX, Math.max(FILES_PANEL_MIN_WIDTH_PX, width)));
}

type StoredPanel = { open?: boolean; width?: number };

export type FilesPanelContextValue = {
  /** Project folder the panel browses; null when no chat or project is active. */
  root: string | null;
  open: boolean;
  /** Wide mode for documents, about 60 % of the window. */
  expanded: boolean;
  width: number;
  location: FilesPanelLocation | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Files this chat's tool calls created or changed, newest first. */
  chatFiles: ChatFile[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setExpanded: (expanded: boolean) => void;
  setWidth: (width: number) => void;
  navigate: (location: FilesPanelLocation) => void;
  back: () => void;
  forward: () => void;
  /** Open the panel on a file, e.g. from a link in the chat. */
  openFile: (path: string, line?: number | null) => void;
};

const FilesPanelContext = createContext<FilesPanelContextValue | null>(null);

/** Null outside the app shell, e.g. in isolated component tests. */
export function useFilesPanel(): FilesPanelContextValue | null {
  return useContext(FilesPanelContext);
}

function sameLocation(a: FilesPanelLocation | undefined, b: FilesPanelLocation) {
  return (
    a?.kind === b.kind &&
    sameHostPath(a.path, b.path) &&
    (a.kind === "folder" || a.line === (b as { line: number | null }).line)
  );
}

export function FilesPanelProvider({ children }: { children: ReactNode }) {
  const { sessions, activeSessionId, activeTargetDirectory } = useSessionState();
  const transcript = useActiveTranscriptSnapshot();
  const { activeWorkspaceId } = useWorkspaceState();
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const root =
    (transcript.scope?.sessionId === activeSessionId ? transcript.scope?.directory : null) ??
    activeSession?._projectDir ??
    activeSession?.directory ??
    activeTargetDirectory ??
    null;
  const chatFiles = useMemo(
    () =>
      transcript.scope?.sessionId === activeSessionId
        ? collectChatFiles(transcript.messages, root)
        : [],
    [transcript.messages, transcript.scope, activeSessionId, root],
  );

  const [stored, setStored] = useState<StoredPanel>(
    () => storageParsed<StoredPanel>(STORAGE_KEYS.FILES_PANEL) ?? {},
  );
  const open = stored.open === true;
  const width = clampFilesPanelWidth(
    typeof stored.width === "number" && Number.isFinite(stored.width)
      ? stored.width
      : FILES_PANEL_DEFAULT_WIDTH_PX,
  );
  const persist = useCallback((patch: StoredPanel) => {
    setStored((previous) => {
      const next = { ...previous, ...patch };
      storageSetJSON(STORAGE_KEYS.FILES_PANEL, next);
      return next;
    });
  }, []);

  const [expanded, setExpanded] = useState(false);
  const scope = `${activeWorkspaceId}\n${root ?? ""}`;
  const [storedHistory, setHistory] = useState<{
    scope: string;
    entries: FilesPanelLocation[];
    index: number;
  }>({
    scope,
    entries: [],
    index: -1,
  });
  // Scope changes must hide the old path during render, before any request starts.
  const history = storedHistory.scope === scope ? storedHistory : { scope, entries: [], index: -1 };

  const navigate = useCallback(
    (location: FilesPanelLocation) => {
      setHistory((previous) => {
        const { entries, index } = previous.scope === scope ? previous : { entries: [], index: -1 };
        if (sameLocation(entries[index], location)) return previous;
        const next = [...entries.slice(0, index + 1), location];
        return { scope, entries: next, index: next.length - 1 };
      });
    },
    [scope],
  );

  const back = useCallback(
    () => setHistory(({ entries, index }) => ({ scope, entries, index: Math.max(-1, index - 1) })),
    [scope],
  );
  const forward = useCallback(
    () =>
      setHistory(({ entries, index }) => ({
        scope,
        entries,
        index: Math.min(entries.length - 1, index + 1),
      })),
    [scope],
  );

  const setOpen = useCallback((value: boolean) => persist({ open: value }), [persist]);
  const toggle = useCallback(
    () =>
      setStored((previous) => {
        const next = { ...previous, open: previous.open !== true };
        storageSetJSON(STORAGE_KEYS.FILES_PANEL, next);
        return next;
      }),
    [],
  );
  const setWidth = useCallback(
    (value: number) => persist({ width: clampFilesPanelWidth(value) }),
    [persist],
  );
  const openFile = useCallback(
    (path: string, line: number | null = null) => {
      navigate({ kind: "file", path, line });
      persist({ open: true });
    },
    [navigate, persist],
  );

  useKeyboardShortcuts(
    useMemo(
      () => [
        (event: KeyboardEvent) => {
          if (event.key.toLowerCase() !== "e" || !event.shiftKey || !isModKey(event)) return;
          if (isEditableTarget(event.target)) return;
          event.preventDefault();
          toggle();
          return true;
        },
      ],
      [toggle],
    ),
  );

  const value = useMemo<FilesPanelContextValue>(
    () => ({
      root,
      open,
      expanded,
      width,
      location: history.entries[history.index] ?? null,
      canGoBack: history.index >= 0,
      canGoForward: history.index < history.entries.length - 1,
      chatFiles,
      setOpen,
      toggle,
      setExpanded,
      setWidth,
      navigate,
      back,
      forward,
      openFile,
    }),
    [
      root,
      open,
      expanded,
      width,
      history,
      chatFiles,
      setOpen,
      toggle,
      setWidth,
      navigate,
      back,
      forward,
      openFile,
    ],
  );

  return <FilesPanelContext.Provider value={value}>{children}</FilesPanelContext.Provider>;
}
