export function shouldShowStopButton({
  isLoading,
  isCompactingInProgress,
}: {
  isLoading?: boolean;
  isCompactingInProgress?: boolean;
}) {
  return Boolean(isLoading || isCompactingInProgress);
}
