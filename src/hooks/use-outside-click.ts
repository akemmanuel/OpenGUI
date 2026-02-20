import type { RefObject } from "react";
import { useEffect } from "react";

/**
 * Calls `onClose` when a click lands outside `ref` or the Escape key is pressed.
 *
 * The hook only attaches listeners when `active` is true, so it's safe to
 * call unconditionally and toggle via the flag.
 */
export function useOutsideClick(
	ref: RefObject<HTMLElement | null>,
	onClose: () => void,
	active: boolean,
): void {
	useEffect(() => {
		if (!active) return;

		const onPointerDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (ref.current?.contains(target)) return;
			onClose();
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};

		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onEscape);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onEscape);
		};
	}, [ref, onClose, active]);
}
