/** Format an ISO date string or epoch-ms timestamp as a relative label. */
export function formatTimeAgo(date: string | number): string {
  const ms = typeof date === "string" ? Date.parse(date) : date;
  if (Number.isNaN(ms)) return "";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
