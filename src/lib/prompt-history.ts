/**
 * Determines whether arrow-key history navigation should activate based on
 * the current cursor position inside the textarea.
 *
 * - Arrow Up triggers history only when the cursor is at position 0 (very start).
 * - Arrow Down triggers history only when the cursor is at the end of the text.
 * - When already browsing history (`inHistory`), navigation is allowed from
 *   either boundary to make it easier to step through entries.
 */
export function canNavigateHistoryAtCursor(
	direction: "up" | "down",
	text: string,
	cursorPosition: number,
	inHistory: boolean,
): boolean {
	const pos = Math.max(0, Math.min(cursorPosition, text.length));

	// Already browsing history - allow from either boundary
	if (inHistory) return pos === 0 || pos === text.length;

	// Entering history for the first time
	if (direction === "up") return pos === 0;
	return pos === text.length;
}
