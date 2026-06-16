export function shouldShowStopButton({ isSessionRunning }: { isSessionRunning?: boolean }) {
  return Boolean(isSessionRunning);
}

export function shouldShowSendButton({
  hasPromptText,
  isSessionRunning,
}: {
  hasPromptText: boolean;
  isSessionRunning?: boolean;
}) {
  return hasPromptText || !isSessionRunning;
}
