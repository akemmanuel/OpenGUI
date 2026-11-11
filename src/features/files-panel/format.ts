const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatFileSize(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

/** Time for today, day and month for this year, a short date otherwise. */
export function formatFileDate(ms: number, locale: string, now = new Date()): string {
  const date = new Date(ms);
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
}
