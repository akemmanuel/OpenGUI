import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";

type Theme = "dark" | "light";

function getStoredTheme(): Theme {
	const stored = storageGet(STORAGE_KEYS.THEME);
	if (stored === "dark" || stored === "light") return stored;
	return "dark";
}

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
	const [theme, setThemeState] = useState<Theme>(getStoredTheme);

	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	const setTheme = useCallback((t: Theme) => {
		storageSet(STORAGE_KEYS.THEME, t);
		setThemeState(t);
	}, []);

	const toggleTheme = useCallback(() => {
		setThemeState((prev) => {
			const next = prev === "dark" ? "light" : "dark";
			storageSet(STORAGE_KEYS.THEME, next);
			return next;
		});
	}, []);

	return { theme, setTheme, toggleTheme } as const;
}
