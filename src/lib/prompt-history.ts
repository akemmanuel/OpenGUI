/**
 * Determines whether arrow-key history navigation should activate based on
 * the current cursor position inside the textarea.
 *
 * Chat-style prompt boxes should not steal plain Arrow Up / Arrow Down while
 * the user is editing a draft. So history activates only when the prompt is
 * empty, or when the user is already browsing history.
 *
 * - With non-empty text and `inHistory === false`, both arrows stay native.
 * - With empty text, only Arrow Up may enter history from position 0.
 * - When already browsing history (`inHistory`), navigation is allowed from
 *   either boundary to make it easy to step through entries and restore draft.
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

	// Never steal plain arrows while user is editing a non-empty draft
	if (text.length > 0) return false;

	// Empty draft: only Arrow Up enters history
	if (direction === "up") return pos === 0;
	return false;
}
