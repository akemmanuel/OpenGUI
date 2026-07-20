export const SIDEBAR_COOKIE_NAME = "sidebar_state";
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export function createSidebarCookie(open: boolean): string {
  return `${SIDEBAR_COOKIE_NAME}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
}

export function persistSidebarOpenState(open: boolean): void {
  document.cookie = createSidebarCookie(open);
}
