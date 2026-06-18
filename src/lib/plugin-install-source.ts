/** Heuristic validation for manual plugin install sources (Discover tab). */
export function isPlausiblePluginInstallSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  if (/^[\w.-]+\/[\w.-]+(@[\w.-]+)?$/i.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^git@/i.test(trimmed)) return true;
  return false;
}
