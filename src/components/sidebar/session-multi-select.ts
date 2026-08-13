export interface SessionMultiSelectState {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
}

export const EMPTY_SESSION_MULTI_SELECT: SessionMultiSelectState = {
  selectedIds: new Set(),
  anchorId: null,
};

export function toggleSessionSelection(
  state: SessionMultiSelectState,
  sessionId: string,
): SessionMultiSelectState {
  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(sessionId)) selectedIds.delete(sessionId);
  else selectedIds.add(sessionId);
  return { selectedIds, anchorId: sessionId };
}

export function selectSessionRange(
  state: SessionMultiSelectState,
  sessionId: string,
  visibleSessionIds: readonly string[],
): SessionMultiSelectState {
  const anchorId = state.anchorId ?? sessionId;
  const anchorIndex = visibleSessionIds.indexOf(anchorId);
  const targetIndex = visibleSessionIds.indexOf(sessionId);
  if (anchorIndex < 0 || targetIndex < 0) {
    return { selectedIds: new Set([sessionId]), anchorId: sessionId };
  }
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return { selectedIds: new Set(visibleSessionIds.slice(start, end + 1)), anchorId };
}

export function pruneSessionSelection(
  state: SessionMultiSelectState,
  visibleSessionIds: readonly string[],
): SessionMultiSelectState {
  const visible = new Set(visibleSessionIds);
  const selectedIds = new Set([...state.selectedIds].filter((id) => visible.has(id)));
  const anchorId = state.anchorId && visible.has(state.anchorId) ? state.anchorId : null;
  if (selectedIds.size === state.selectedIds.size && anchorId === state.anchorId) return state;
  return { selectedIds, anchorId };
}
