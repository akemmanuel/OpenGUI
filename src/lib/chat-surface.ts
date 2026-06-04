export type ChatSurfaceState =
  | { kind: "session"; sessionId: string }
  | { kind: "project"; directory: string }
  | { kind: "default-chat"; directory: string }
  | { kind: "no-project" };

export function getChatSurfaceState(input: {
  activeSessionId: string | null;
  activeTargetDirectory: string | null;
  defaultChatDirectory: string | null;
}): ChatSurfaceState {
  if (input.activeSessionId) return { kind: "session", sessionId: input.activeSessionId };
  if (input.activeTargetDirectory)
    return { kind: "project", directory: input.activeTargetDirectory };
  if (input.defaultChatDirectory)
    return { kind: "default-chat", directory: input.defaultChatDirectory };
  return { kind: "no-project" };
}

export function hasProjectConnectedPrompt(state: ChatSurfaceState) {
  return state.kind === "session" || state.kind === "project";
}
