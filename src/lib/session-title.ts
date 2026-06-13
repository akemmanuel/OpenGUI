const ROLE_PREFIX_PATTERN = /^(?:human|assistant|user)\s*:\s*/i;

export function cleanSessionTitle(title: string | null | undefined): string {
  const trimmed = String(title ?? "").trim();
  if (!trimmed) return "";

  return trimmed.replace(ROLE_PREFIX_PATTERN, "").trim() || trimmed;
}
