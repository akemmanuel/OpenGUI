export function readViewLinkToken(url = window.location.href) {
  return new URL(url).searchParams.get("view")?.trim() || null;
}
