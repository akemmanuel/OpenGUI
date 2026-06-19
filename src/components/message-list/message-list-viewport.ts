/** Viewport mode for the message list chrome (loading / error / empty / transcript). */
export type MessageListViewportState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "transcript" };

export function resolveMessageListViewport(input: {
  visibleCount: number;
  isBusy: boolean;
  isLoadingMessages: boolean;
  activeSessionId: string | null;
  activeLoadError: string | null;
  activeLoadErrorText: string | null;
}): MessageListViewportState {
  const noMessages = input.visibleCount === 0;

  if (noMessages && input.activeLoadError && input.activeSessionId && !input.isBusy) {
    return {
      kind: "error",
      message: input.activeLoadErrorText ?? input.activeLoadError,
    };
  }

  if (noMessages && input.isLoadingMessages && !input.activeLoadError) {
    return { kind: "loading" };
  }

  if (noMessages && !input.isBusy) {
    return { kind: "empty" };
  }

  return { kind: "transcript" };
}
