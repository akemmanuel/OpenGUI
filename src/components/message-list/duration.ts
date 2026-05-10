export function hideZeroDurationLabel(label: string | null): string | null {
  if (!label) return null;
  return label === "0.0s" ? null : label;
}

export function formatWholeSecondDuration(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${(safeMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(safeMs / 1000);
  if (totalSeconds < 60) {
    if (totalSeconds < 10) return `${(safeMs / 1000).toFixed(1)}s`;
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
}
