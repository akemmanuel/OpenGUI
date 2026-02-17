import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

function getStoredTheme(): Theme {
	try {
		const stored = localStorage.getItem("theme");
		if (stored === "dark" || stored === "light") return stored;
	} catch {}
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
		localStorage.setItem("theme", t);
		setThemeState(t);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme(theme === "dark" ? "light" : "dark");
	}, [theme, setTheme]);

	return { theme, setTheme, toggleTheme } as const;
}
